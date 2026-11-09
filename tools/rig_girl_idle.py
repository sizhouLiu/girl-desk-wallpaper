"""Rig the baked CHAR_Girl mesh in the original, optimized night-room GLB.

Run in Blender 5.3: blender -b --python-exit-code 1 --python tools/rig_girl_idle.py
    -- ORIGINAL.glb OUTPUT.glb OUTPUT.blend
"""
import json
import math
from pathlib import Path
import struct
import sys
import tempfile

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector
import numpy as np


# Blender-space landmarks on the seated mesh, before the room placement transform.
BONES = (
    ("Seat", None, (.57, .02, -.32), (.57, .02, -.22), 0),
    ("Hips", "Seat", (.55, .02, -.27), (.62, .02, -.12), .20),
    ("Spine", "Hips", (.62, .02, -.12), (.69, .03, .05), .17),
    ("Chest", "Spine", (.69, .03, .05), (.74, .04, .22), .18),
    ("Neck", "Chest", (.74, .04, .22), (.76, .05, .33), .10),
    ("Head", "Neck", (.76, .05, .33), (.77, .07, .60), .16),
    ("Hair", "Head", (.90, .045, .35), (.93, .035, .10), .13),
    ("UpperArm.R", "Chest", (.71, .20, .18), (.50, .31, .035), .10),
    ("Forearm.R", "UpperArm.R", (.50, .31, .035), (.54, .19, .26), .09),
    ("Hand.R", "Forearm.R", (.54, .19, .26), (.59, .115, .315), .055),
    ("UpperArm.L", "Chest", (.72, -.15, .17), (.68, -.28, -.095), .11),
    ("Forearm.L", "UpperArm.L", (.68, -.28, -.095), (.355, -.20, -.105), .08),
    ("Hand.L", "Forearm.L", (.355, -.20, -.105), (.266, -.184, -.157), .057),
    ("Thigh.R", "Hips", (.50, .13, -.25), (-.145, .155, -.103), .12),
    ("Shin.R", "Thigh.R", (-.145, .155, -.103), (-.735, .265, -.449), .09),
    ("Foot.R", "Shin.R", (-.735, .265, -.449), (-.94, .265, -.477), .10),
    ("Thigh.L", "Hips", (.52, -.10, -.28), (-.10, -.045, -.204), .12),
    ("Shin.L", "Thigh.L", (-.10, -.045, -.204), (-.645, -.085, -.509), .09),
    ("Foot.L", "Shin.L", (-.645, -.085, -.509), (-.88, -.092, -.553), .10),
)

FPS = 24
CLIPS = (("Breathe", 6), ("LookAside", 6), ("Settle", 6), ("FootReposition", 7))
BASIS = Matrix.Rotation(-math.pi / 2, 4, "X")
LEG_CHAINS = (
    (("Thigh.L", "Shin.L", "Foot.L"), (.035, .53), (.14, -.025, .10), -15),
    (("Thigh.R", "Shin.R", "Foot.R"), (.47, .965), (.095, .028, .085), -12),
)


def glb_bytes(doc, binary):
    payload = json.dumps(doc, separators=(",", ":")).encode()
    payload += b" " * (-len(payload) % 4)
    chunks = struct.pack("<I4s", len(payload), b"JSON") + payload
    chunks += struct.pack("<I4s", len(binary), b"BIN\0") + binary
    return struct.pack("<4sII", b"glTF", 2, len(chunks) + 12) + chunks


def smoothstep(lo, hi, value):
    t = np.clip((value - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def bind_weights(points):
    x, y, z = points.T
    # Keep the chair fragments fused into the baked coat and the seated contact area anchored.
    chair = smoothstep(.22, .33, -y) * (1 - smoothstep(-.18, -.105, z))
    seat = smoothstep(-.31, -.42, z) * smoothstep(.12, .29, x)
    support = np.maximum(chair, seat)
    head_zone = smoothstep(.21, .35, z) * smoothstep(.535, .668, x)
    hair_zone = smoothstep(.78, .88, x) * smoothstep(.045, .19, z)
    right_arm = smoothstep(.055, .22, y) * (1 - head_zone)
    left_arm = smoothstep(.08, .22, -y) * smoothstep(-.23, -.08, z)
    leg_zone = 1 - smoothstep(.20, .42, x)
    right_leg = smoothstep(.00, .10, y)
    scores = np.zeros((len(points), len(BONES)), dtype=np.float32)
    for i, (name, _, head, tail, radius) in enumerate(BONES[1:], 1):
        a, b = np.array(head, dtype=np.float32), np.array(tail, dtype=np.float32)
        segment = b - a
        p = points - a
        t = np.clip(np.einsum("ij,j->i", p, segment) / (segment @ segment), 0, 1)
        offset = p - t[:, None] * segment
        distance = np.einsum("ij,ij->i", offset, offset)
        score = np.exp(-2.5 * distance / radius**2)
        if name == "Head":
            score *= .06 + 4 * head_zone
        elif name == "Hair":
            score *= hair_zone
        elif name.startswith(("UpperArm.", "Forearm.", "Hand.")):
            score *= right_arm if name.endswith(".R") else left_arm
        elif name.startswith(("Thigh.", "Shin.", "Foot.")):
            side = right_leg if name.endswith(".R") else 1 - right_leg
            score *= (.12 + .88 * leg_zone) * (.03 + .97 * side)
        elif name != "Neck":
            score *= (1 - .96 * head_zone) * (1 - .99 * leg_zone)
        scores[:, i] = score
    scores[:, 0] = scores.max(axis=1) * (.025 * (1 - leg_zone) + 18 * support)
    joints = np.argsort(-scores, axis=1, kind="stable")[:, :4]
    weights = np.take_along_axis(scores, joints, axis=1)
    weights /= weights.sum(axis=1, keepdims=True)
    # Quantize to glTF normalized bytes and put the rounding remainder on the largest influence.
    packed = np.floor(weights * 255 + .5).astype(np.int16)
    packed[:, 0] += 255 - packed.sum(axis=1)
    return joints.astype(np.uint8), packed.astype(np.uint8)


def pose_degrees(name, t):
    if t == 0 or t == 1:
        return {}
    breathe = math.sin(math.pi * t) ** 2
    glance = math.sin(math.pi * t) ** 4 if name == "LookAside" else 0
    settle = math.sin(math.pi * t) ** 4 if name == "Settle" else 0
    # Rotations around the model-space axes, converted to each bone's own rest axes.
    return {
        "Spine": (2.5 * settle, -1.3 * breathe - 2.8 * settle, 2.3 * settle),
        "Chest": (-1.8 * settle, -2.5 * breathe + 1.4 * settle, -1.2 * settle + 1.5 * glance),
        "Neck": (-1.4 * glance, .75 * breathe + 2.0 * glance, 4.0 * glance),
        "Head": (-2.4 * glance, 1.2 * breathe + 2.8 * glance, 16.0 * glance),
        "Hair": (0, 1.1 * breathe - 2.2 * glance, -3.5 * glance),
        "UpperArm.R": (-1.2 * glance, .4 * breathe, 2.5 * glance),
        "Forearm.R": (1.8 * glance, -.55 * breathe, 4.0 * glance),
        "UpperArm.L": (1.2 * settle, 2.4 * breathe - 2.5 * settle, 1.3 * settle),
        "Forearm.L": (-1.4 * settle, .9 * breathe + 2.2 * settle, -2.8 * settle),
        "Hand.L": (0, -7.5 * settle, 1.7 * settle),
    }


def leg_pose(chain, bases, t):
    (thigh, shin, foot), (start, end), offset, pitch = chain
    phase = min(1, max(0, (t - start) / (end - start)))
    if phase in (0, 1):
        return dict.fromkeys((thigh, shin, foot), Quaternion())
    lift = math.sin(math.pi * phase) ** 2
    hip, knee, ankle = (bases[name].translation for name in (thigh, shin, foot))
    upper, lower = knee - hip, ankle - knee
    target = ankle + lift * Vector(offset)
    direction = (target - hip).normalized()
    # Solve the knee in the original bend plane, preserving both bone lengths.
    distance = (target - hip).length
    along = (upper.length_squared - lower.length_squared + distance**2) / (2 * distance)
    bend = (upper - direction * upper.dot(direction)).normalized()
    new_upper = direction * along + bend * math.sqrt(max(0, upper.length_squared - along**2))
    new_lower = target - hip - new_upper
    thigh_turn = upper.rotation_difference(new_upper)
    shin_world = (thigh_turn @ lower).rotation_difference(new_lower) @ thigh_turn
    foot_turn = Quaternion((0, 1, 0), math.radians(pitch * lift))
    # The foot pitch is relative to the floor, independent of the knee rotation.
    turns = (thigh_turn, thigh_turn.inverted() @ shin_world, shin_world.inverted() @ foot_turn)
    return {
        name: bases[name].to_quaternion().inverted() @ turn @ bases[name].to_quaternion()
        for name, turn in zip((thigh, shin, foot), turns)
    }


def pose_rotations(name, matrices, t):
    rotations = {}
    for bone, degrees in pose_degrees(name, t).items():
        if any(degrees):
            basis = matrices[bone].to_quaternion()
            delta = Euler(tuple(map(math.radians, degrees)), "XYZ").to_quaternion()
            rotations[bone] = basis.inverted() @ delta @ basis
    if name == "FootReposition":
        for chain in LEG_CHAINS:
            rotations.update(leg_pose(chain, matrices, t))
    return rotations


def make_rig(model, joints, weights):
    scene = bpy.context.scene
    model.matrix_world = Matrix.Identity(4)
    rig = bpy.data.objects.new("Girl_Idle_Rig", bpy.data.armatures.new("Seated character"))
    scene.collection.objects.link(rig)
    rig.show_in_front = True
    rig.data.display_type = "STICK"
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, parent, head, tail, _ in BONES:
        bone = rig.data.edit_bones.new(name)
        bone.head, bone.tail = head, tail
        if parent:
            bone.parent = rig.data.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    for i, (name, *_rest) in enumerate(BONES):
        group = model.vertex_groups.new(name=name)
        for slot in range(joints.shape[1]):
            indices = np.flatnonzero((joints[:, slot] == i) & (weights[:, slot] > 0))
            for weight in np.unique(weights[indices, slot]):
                group.add(indices[weights[indices, slot] == weight].tolist(), int(weight) / 255, "REPLACE")
    model.parent = rig
    modifier = model.modifiers.new("Seated skin", "ARMATURE")
    modifier.object = rig
    return rig


def add_animation(doc, binary, model_index, rig, joints, weights):
    def accessor(values, kind, component=5126, normalized=False, target=None):
        binary.extend(b"\0" * (-len(binary) % 4))
        data = values.tobytes()
        view = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)}
        if target:
            view["target"] = target
        a = {"bufferView": len(doc["bufferViews"]), "type": kind,
             "componentType": component, "count": len(values)}
        if normalized:
            a["normalized"] = True
        if kind == "SCALAR":
            a.update(min=[float(values[0])], max=[float(values[-1])])
        doc["bufferViews"].append(view)
        doc["accessors"].append(a)
        binary.extend(data)
        return len(doc["accessors"]) - 1

    model = doc["nodes"][model_index]
    primitive = doc["meshes"][model["mesh"]]["primitives"][0]
    primitive["attributes"]["JOINTS_0"] = accessor(joints, "VEC4", 5121, target=34962)
    primitive["attributes"]["WEIGHTS_0"] = accessor(weights, "VEC4", 5121, True, 34962)
    mesh_index = len(doc["nodes"])
    doc["nodes"].append({"name": "CHAR_Girl_Skin", "mesh": model.pop("mesh"), "skin": 0})
    model["children"] = [mesh_index, mesh_index + 1]

    matrices = {b.name: b.matrix_local.copy() for b in rig.data.bones}
    indices = {}
    bind_inverses = []
    rest = {}
    for name, parent, *_ in BONES:
        local = matrices[parent].inverted() @ matrices[name] if parent else matrices[name]
        rest[name] = (BASIS @ local @ BASIS.inverted()).to_quaternion()
        loc = BASIS @ local.translation
        indices[name] = len(doc["nodes"])
        doc["nodes"].append({"name": "Girl_" + name, "translation": list(loc),
                             "rotation": [*rest[name][1:], rest[name].w]})
        if parent:
            doc["nodes"][indices[parent]].setdefault("children", []).append(indices[name])
        inv = BASIS @ matrices[name].inverted() @ BASIS.inverted()
        bind_inverses.append(np.array(inv, dtype="<f4").T.ravel())
    doc["skins"] = [{"name": "Seated character", "joints": list(indices.values()),
                     "skeleton": indices["Seat"],
                     "inverseBindMatrices": accessor(np.array(bind_inverses), "MAT4")}]

    scene = bpy.context.scene
    scene.render.fps = FPS
    actions = []
    animations = []
    for name, seconds in CLIPS:
        clip_name = "GirlIdle_" + name
        action = bpy.data.actions.new(clip_name)
        action.use_fake_user = True
        rig.animation_data_create().action = action
        end = seconds * FPS
        frames = range(0, end + 1, 4)
        times = accessor(np.array(frames, dtype="<f4") / FPS, "SCALAR")
        samplers, channels = [], []
        poses = [pose_rotations(name, matrices, frame / end) for frame in frames]
        for bone_name in matrices:
            if all(bone_name not in pose for pose in poses):
                continue
            rotations = []
            bone = rig.pose.bones[bone_name]
            bone.rotation_mode = "QUATERNION"
            for frame, pose in zip(frames, poses):
                local = pose.get(bone_name, Quaternion())
                bone.rotation_quaternion = local
                bone.keyframe_insert(data_path="rotation_quaternion", frame=frame + 1, group=bone_name)
                converted = BASIS.to_quaternion() @ local @ BASIS.to_quaternion().inverted()
                q = rest[bone_name] @ converted
                rotations.append([q.x, q.y, q.z, q.w])
            channels.append({"sampler": len(samplers), "target": {"node": indices[bone_name], "path": "rotation"}})
            samplers.append({"input": times, "output": accessor(np.array(rotations, dtype="<f4"), "VEC4")})
        for curve in action.layers[0].strips[0].channelbag(rig.animation_data.action_slot).fcurves:
            for key in curve.keyframe_points:
                key.interpolation = "LINEAR"
        actions.append(action)
        animations.append({"name": clip_name, "samplers": samplers, "channels": channels})
    doc["animations"] = animations
    rig.animation_data.action = None
    track = rig.animation_data.nla_tracks.new()
    track.name = "Seated idle sequence"
    start = 1
    for (name, seconds), action in zip(CLIPS, actions):
        strip = track.strips.new(name, start, action)
        strip.extrapolation = "NOTHING"
        scene.timeline_markers.new(name, frame=start)
        start += seconds * FPS
    scene.frame_end = start - 1
    scene.frame_set(1)


def main():
    src, dst, blend = (Path(p).resolve() for p in sys.argv[sys.argv.index("--") + 1:])
    data = src.read_bytes()
    json_size, json_type = struct.unpack_from("<I4s", data, 12)
    binary_size, binary_type = struct.unpack_from("<I4s", data, 20 + json_size)
    if data[:4] != b"glTF" or json_type != b"JSON" or binary_type != b"BIN\0":
        raise ValueError("Expected a binary glTF scene")
    doc = json.loads(data[20:20 + json_size])
    binary = bytearray(data[28 + json_size:28 + json_size + binary_size])
    model_index = next(i for i, n in enumerate(doc["nodes"]) if n.get("name") == "CHAR_Girl")
    model_node = doc["nodes"][model_index]
    if doc.get("skins") or doc.get("animations") or model_node.get("children"):
        raise ValueError("Use the original static night-room GLB")
    mesh = doc["meshes"][model_node["mesh"]]
    if len(mesh["primitives"]) != 1:
        raise ValueError("Expected a single baked character primitive")

    # Import only the girl; all original room and material bytes remain intact in the output GLB.
    scenes, scene_index = doc["scenes"], doc["scene"]
    doc["scenes"], doc["scene"] = [{"nodes": [model_index]}], 0
    with tempfile.TemporaryDirectory() as folder:
        isolated = Path(folder) / "character.glb"
        isolated.write_bytes(glb_bytes(doc, binary))
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(isolated), merge_vertices=False)
    doc["scenes"], doc["scene"] = scenes, scene_index
    model = bpy.data.objects["CHAR_Girl"]
    bpy.data.batch_remove([obj for obj in bpy.data.objects if obj != model])
    bpy.data.orphans_purge(do_recursive=True)
    points = np.empty(len(model.data.vertices) * 3, dtype=np.float32)
    model.data.vertices.foreach_get("co", points)
    position = mesh["primitives"][0]["attributes"]["POSITION"]
    if len(model.data.vertices) != doc["accessors"][position]["count"]:
        raise ValueError("Imported vertex indices do not match the source primitive")
    joints, weights = bind_weights(points.reshape(-1, 3))
    rig = make_rig(model, joints, weights)
    add_animation(doc, binary, model_index, rig, joints, weights)

    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                view = area.spaces.active
                view.region_3d.view_rotation = Vector((-3, -4, 1)).to_track_quat("Z", "Y")
                view.region_3d.view_distance = 3.15
                view.region_3d.view_location = (0, 0, 0)
                view.shading.type = "MATERIAL"
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(blend), compress=True)
    doc["buffers"][0]["byteLength"] = len(binary)
    temporary = dst.with_suffix(".tmp")
    temporary.write_bytes(glb_bytes(doc, binary))
    temporary.replace(dst)


if __name__ == "__main__":
    main()
