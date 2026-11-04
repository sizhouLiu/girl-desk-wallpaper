# Blender headless export: .blend -> <out>/room.glb + <out>/scene.json (+ export_log.txt)
#
#   blender -b scene.blend --python pipeline/export_scene.py -- --config wallpaper.config.json --out export
#                                                               [--rebake] [--bake-size 1024]
#
# Never saves the .blend: every change below (material rewiring, UVs, disabled modifiers) only lives in this
# Blender session. Everything scene-specific comes from wallpaper.config.json ("export" + "runtime" sections).
import bpy
import json
import os
import sys
import time
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    if name not in argv:
        return default
    i = argv.index(name)
    return argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith("--") else True


CFG_PATH = os.path.abspath(arg("--config", "wallpaper.config.json"))
OUT = os.path.abspath(arg("--out", "export"))
cfg = json.load(open(CFG_PATH, encoding="utf-8"))
EX = cfg.get("export", {})
RT = cfg.get("runtime", {})
os.makedirs(OUT, exist_ok=True)
t0 = time.time()
lines = []


def log(*a):
    s = " ".join(str(x) for x in a)
    print("[export] " + s, flush=True)
    lines.append(s)


sc = bpy.context.scene
if EX.get("scene"):
    if EX["scene"] not in bpy.data.scenes:
        raise SystemExit("scene not found: %s (have: %s)" % (EX["scene"], ", ".join(s.name for s in bpy.data.scenes)))
    sc = bpy.data.scenes[EX["scene"]]
    wm = bpy.context.window_manager
    if wm.windows:
        wm.windows[0].scene = sc          # operators (bake, glTF export) act on the context scene
    log("scene:", sc.name)
DG = bpy.context.evaluated_depsgraph_get()


def MW(o):   # world matrix after constraints (e.g. a Track-To camera)
    return o.evaluated_get(DG).matrix_world


# Blender Z-up -> glTF / three.js Y-up
def v3(v, nd=4):
    return [round(v.x, nd), round(v.z, nd), round(-v.y, nd)]


def principled(mat):
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if mat and mat.use_nodes else None


def surface_node(mat):
    if not mat or not mat.use_nodes:
        return None, None
    out = next((n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    if out is None or not out.inputs["Surface"].links:
        return out, None
    return out, out.inputs["Surface"].links[0].from_node


# ---------------------------------------------------------------- objects to export
cutters = {m.object.name for o in sc.objects for m in o.modifiers if m.type == "BOOLEAN" and m.object}
exclude = set(EX.get("exclude", []))
objs = [o for o in sc.objects if o.type == "MESH" and o.visible_get() and o.name not in cutters and o.name not in exclude]
if exclude:
    log("excluded by config:", ", ".join(sorted(exclude)))
log("meshes to export", len(objs), "(boolean cutters skipped:", ", ".join(sorted(cutters)) or "none", ")")
# Cycles ray visibility: hidden from the camera but casting shadows (e.g. leaf canopy for dappled light), or
# visible but not casting. The web runtime reproduces both.
shadow_only = [o.name for o in objs if not getattr(o, "visible_camera", True)]
no_shadow = [o.name for o in objs if not getattr(o, "visible_shadow", True)]
if shadow_only or no_shadow:
    log("shadow-only:", ", ".join(shadow_only) or "-", "| no shadow:", ", ".join(no_shadow) or "-")

# toon outlines are drawn by the web runtime: record which objects had one, then switch the modifier off
outline_mod = EX.get("outlineModifier", "ToonOutlineGN")
outlined = []
for o in objs:
    hit = False
    for m in o.modifiers:
        if m.type == "NODES" and m.node_group and m.node_group.name.startswith(outline_mod):
            m.show_viewport = False
            m.show_render = False
            hit = True
    if hit:
        outlined.append(o.name)
log("outlined", len(outlined))

used_mats = {s.material for o in objs for s in o.material_slots if s.material}

# ---------------------------------------------------------------- emissive strengths (read before rewiring)
emissive = {}
for m in bpy.data.materials:
    if m.users == 0 or not m.use_nodes:
        continue
    p = principled(m)
    _, surf = surface_node(m)
    es = p.inputs["Emission Strength"].default_value if p else 0.0
    if p and es > 0:
        emissive[m.name] = es
    elif surf is not None and surf.type == "EMISSION" and p is None:
        emissive[m.name] = surf.inputs["Strength"].default_value

# ---------------------------------------------------------------- bake the character's toon material
# GPU (OptiX and CUDA) EMIT bakes of the character came out solid black on this machine (Blender 5.2.2), CPU is
# correct, so the default is CPU. "device": "GPU" in export.bake opts in; the result is checked either way.
def setup_device(want):
    if want != "GPU":
        sc.cycles.device = "CPU"
        return "CPU"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.refresh_devices()
        for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
            if any(d.type == kind for d in prefs.devices):
                prefs.compute_device_type = kind
                for d in prefs.devices:
                    d.use = d.type == kind
                sc.cycles.device = "GPU"
                return kind
    except Exception as e:  # no GPU / no cycles prefs: CPU bake still works
        log("gpu setup failed:", e)
    sc.cycles.device = "CPU"
    return "CPU"


bake = EX.get("bake")
if bake:
    obj = sc.objects.get(bake["object"])
    src = bpy.data.materials.get(bake["material"])
    if obj is None or src is None:
        raise SystemExit("bake: object/material not found: %s / %s" % (bake["object"], bake["material"]))
    cache = bake.get("cache")
    cache_abs = os.path.abspath(cache) if cache else os.path.join(OUT, bake.get("image", "baked") + ".png")
    uv_name = bake.get("uv", "UVMap")
    if os.path.exists(cache_abs) and not arg("--rebake"):
        img = bpy.data.images.load(cache_abs)
        log("bake: reused", os.path.relpath(cache_abs), "%dx%d" % tuple(img.size))
    else:
        size = int(arg("--bake-size", bake.get("size", 4096)))
        img = bpy.data.images.new(bake.get("image", "baked") + "_bake", size, size, alpha=False)
        nt = src.node_tree
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        for n in nt.nodes:
            n.select = False
        node.select = True
        nt.nodes.active = node
        obj.data.uv_layers.active = obj.data.uv_layers[uv_name]
        sc.render.engine = "CYCLES"
        dev = setup_device(str(bake.get("device", "CPU")).upper())
        sc.cycles.samples = int(bake.get("samples", 16))
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        # EMIT only needs this object, but Cycles syncs (and decodes the images of) everything renderable; some
        # packed Tripo ORM / normal PNGs crash OpenImageIO, so render-hide all other objects for the bake
        hidden = [o for o in sc.objects if o is not obj and not o.hide_render]
        for o in hidden:
            o.hide_render = True
        # Bake only the material's base colour, not its toon shading: the full tree adds view-dependent rim / tint
        # that the web runtime adds again itself. export.bake.colorNode names the node whose colour output is the
        # albedo (here the mix of base texture + iris + face projection); it is routed into a temporary Emission.
        tmp = []
        out_node, _ = surface_node(src)
        if bake.get("colorNode"):
            cn = nt.nodes.get(bake["colorNode"])
            if cn is None:
                raise SystemExit("bake: colorNode not found in %s: %s" % (src.name, bake["colorNode"]))
            sock = next((s for s in cn.outputs if s.is_linked and s.type == "RGBA"), None) or next(s for s in cn.outputs if s.type == "RGBA")
            emi = nt.nodes.new("ShaderNodeEmission")
            emi.inputs["Strength"].default_value = 1.0
            nt.links.new(sock, emi.inputs["Color"])
            nt.links.new(emi.outputs["Emission"], out_node.inputs["Surface"])
            tmp.append(emi)
        tb = time.time()
        try:
            bpy.ops.object.bake(type="EMIT", margin=4, use_clear=True)
        finally:
            for o in hidden:
                o.hide_render = False
            for n in tmp:
                nt.nodes.remove(n)
        # an all-black bake means it silently failed (see setup_device): don't cache or export it
        step = max(1, len(img.pixels) // 4 // 20000) * 4
        sample = img.pixels[::step]
        lum = sum(sample[i] + sample[i + 1] + sample[i + 2] for i in range(0, len(sample) - 3, 4)) / max(1, len(sample) // 4) / 3
        if lum < 0.01:
            raise SystemExit("bake: result is black (mean %.4f) on %s - try \"device\": \"CPU\" in export.bake" % (lum, dev))
        os.makedirs(os.path.dirname(cache_abs), exist_ok=True)
        img.filepath_raw = cache_abs
        img.file_format = "PNG"
        img.save()
        nt.nodes.remove(node)
        log("bake: EMIT %dx%d on %s in %.0fs ->" % (size, size, dev, time.time() - tb), os.path.relpath(cache_abs))
    img.name = bake.get("image", "baked")   # becomes the glTF image name (texture-size rules key on it)
    # simple export material: baked colour on the UV map, nothing else
    em = bpy.data.materials.new(bake.get("exportMaterial", src.name + "_export"))
    em.use_nodes = True
    nt = em.node_tree
    p = principled(em)
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = uv_name
    nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], p.inputs["Base Color"])
    p.inputs["Roughness"].default_value = 1.0
    p.inputs["Metallic"].default_value = 0.0
    em.use_backface_culling = False
    for slot in obj.material_slots:
        if slot.material == src:
            slot.material = em
    # only the baked UV map is needed
    for uv in [u for u in obj.data.uv_layers if u.name != uv_name]:
        obj.data.uv_layers.remove(uv)
    used_mats.discard(src)
    used_mats.add(em)
    emissive.pop(src.name, None)

# ---------------------------------------------------------------- toon materials -> exportable PBR
# Scene toon materials end in an Emission shader (cel ramp built from Shader-to-RGB). glTF can't express that,
# so export the Principled BSDF that sits in the same tree (base colour + emission) and let the web runtime
# rebuild the toon look.
rewired = 0
for m in used_mats:
    out, surf = surface_node(m)
    p = principled(m)
    if surf is not None and surf.type in ("EMISSION", "TEX_IMAGE") and p is not None:
        # an image wired straight into Surface (Tripo "unlit preview" setup) is the colour; the Principled BSDF
        # next to it was left with a flat grey base colour, so carry the image over before swapping the output
        if surf.type == "TEX_IMAGE" and not p.inputs["Base Color"].is_linked:
            m.node_tree.links.new(surf.outputs["Color"], p.inputs["Base Color"])
        m.node_tree.links.new(p.outputs["BSDF"], out.inputs["Surface"])
        rewired += 1
log("materials relinked", rewired)

# The web runtime only uses base colour, emission and alpha (toon shading ignores normal / roughness / metal maps,
# and the optimizer dropped them anyway). Disconnect everything else: some Tripo ORM / normal images hold packed
# data Blender can't decode, and the glTF exporter crashes inside OpenImageIO when it tries to encode them.
KEEP = {"Base Color", "Emission Color", "Emission Strength", "Alpha"}
# export.keepPBR (realistic scenes): keep normal / roughness / metallic maps for the PBR runtime
if EX.get("keepPBR"):
    KEEP |= {"Normal", "Metallic", "Roughness"}
cut = 0
for m in used_mats:
    p = principled(m)
    if p is None:
        continue
    for inp in p.inputs:
        if inp.name not in KEEP and inp.links:
            for l in list(inp.links):
                m.node_tree.links.remove(l)
                cut += 1
log("unused texture links removed", cut)

# ---------------------------------------------------------------- box-projected UVs (procedural mapping in Blender)
box = EX.get("boxUV", {})
reuv = 0
for o in objs:
    slots = {i: s.material.name for i, s in enumerate(o.material_slots) if s.material and s.material.name in box}
    if not slots:
        continue
    me = o.data
    uvl = me.uv_layers.active or me.uv_layers.new(name="UVMap")
    mw = o.matrix_world
    nm = mw.to_3x3()
    for poly in me.polygons:
        if poly.material_index not in slots:
            continue
        t = float(box[slots[poly.material_index]].get("tile", 1.0))
        n = (nm @ poly.normal).normalized()
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for li in poly.loop_indices:
            w = mw @ me.vertices[me.loops[li].vertex_index].co
            if az >= ax and az >= ay:        # floor / ceiling / top faces
                uv = (w.x / t, w.y / t)
            elif ay >= ax:                   # faces along Blender Y (three.js Z)
                uv = (w.x / t, w.z / t)
            else:                            # faces along Blender X
                uv = (-w.y / t, w.z / t)
            uvl.data[li].uv = uv
    reuv += 1
for mn in box:
    m = bpy.data.materials.get(mn)
    if m and m.use_nodes:
        for n in m.node_tree.nodes:
            if n.type == "TEX_IMAGE":
                for l in list(n.inputs["Vector"].links):
                    m.node_tree.links.remove(l)
log("box-projected materials", json.dumps({k: v.get("tile") for k, v in box.items()}), "re-UV'd objects", reuv)

# ---------------------------------------------------------------- scene.json: what three.js can't read from the GLB
cams = {}
for o in sc.objects:
    if o.type != "CAMERA":
        continue
    q = MW(o).to_quaternion()
    cams[o.name] = {
        "aspect": round(sc.render.resolution_x / sc.render.resolution_y, 5),
        "pos": v3(MW(o).translation),
        "quat": [round(q.x, 5), round(q.z, 5), round(-q.y, 5), round(q.w, 5)],   # swizzled, see main.js useCamera
        "lens": round(o.data.lens, 4), "sensor": o.data.sensor_width, "fov": __import__("math").degrees(o.data.angle_y),
    }

lights = []
for o in sorted((o for o in sc.objects if o.type == "LIGHT"), key=lambda o: o.name):
    d = o.data
    if o.hide_render:
        continue
    lights.append({
        "name": o.name, "type": d.type, "energy": d.energy, "color": list(d.color),
        "pos": v3(MW(o).translation),
        "dir": v3((MW(o).to_3x3() @ Vector((0, 0, -1))).normalized()),
        "size": d.size if d.type == "AREA" else 0, "radius": d.shadow_soft_size,
        **({"angle": d.angle} if d.type == "SUN" else {}),
    })


def bbox(name):
    o = sc.objects.get(name)
    if o is None:
        log("warning: interactive object not found:", name)
        return None
    me = o.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
    pts = [o.matrix_world @ v.co for v in me.vertices] or [o.matrix_world @ Vector(c) for c in o.bound_box]
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return {"name": name, "min": v3(mn), "max": v3(mx)}


ic = RT.get("interact", {})
groups = {
    "lamp": ic.get("lamp", []),
    "clock": [ic["clock"]["object"]] if ic.get("clock") else [],
    "cat": [ic["cat"]] if ic.get("cat") else [],
    "window": [x for x in (ic.get("window", {}).get("view"), ic.get("window", {}).get("glass")) if x],
    "monitors": ic.get("monitors", []),
}
interactive = {k: [b for b in map(bbox, v) if b] for k, v in groups.items() if v}

books = {k: v for k, v in RT.get("books", {}).items() if k in sc.objects}
missing = [k for k in RT.get("books", {}) if k not in sc.objects]
if missing:
    log("warning: book objects not in scene:", " ".join(missing))

def world_info():
    w = sc.world
    if not w or not w.use_nodes:
        return None
    bg = next((n for n in w.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg is None:
        return None
    return {"color": [round(c, 4) for c in bg.inputs["Color"].default_value[:3]], "strength": bg.inputs["Strength"].default_value,
            "textured": bg.inputs["Color"].is_linked}


meta = {
    "cameras": cams, "lights": lights, "books": books, "interactive": interactive,
    "outlined": outlined, "emissive": emissive, "shadowOnly": shadow_only, "noShadow": no_shadow,
    "world": world_info(),
    "exposure": sc.view_settings.exposure, "render": [sc.render.resolution_x, sc.render.resolution_y],
}
with open(os.path.join(OUT, "scene.json"), "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False, indent=1)
log("scene.json: cams", list(cams), "lights", len(lights), "books", len(books), "emissive mats", len(emissive))

# ---------------------------------------------------------------- GLB
bpy.ops.object.select_all(action="DESELECT")
for o in objs:
    o.select_set(True)
# export.animations: also select the armatures driving exported meshes and write their actions
ANIM = bool(EX.get("animations"))
if ANIM:
    for o in objs:
        for m in o.modifiers:
            if m.type == "ARMATURE" and m.object: m.object.select_set(True)
glb = os.path.join(OUT, "room.glb")
bpy.ops.export_scene.gltf(
    filepath=glb, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
    export_cameras=False, export_lights=False, export_extras=False, export_animations=ANIM,
    export_texcoords=True, export_normals=True, export_materials="EXPORT", export_image_format="AUTO",
)
log("GLB %.0f MB" % (os.path.getsize(glb) / 1e6), "in %.0fs total" % (time.time() - t0))

with open(os.path.join(OUT, "export_log.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
print("@@EXPORT_OK@@", flush=True)
