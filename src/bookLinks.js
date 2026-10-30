// Free / open versions of the shelf books, keyed by the title used in scene.json.
//   free: the author or publisher puts the full text online for free (open licence or free reading)
//   code: no free text, but the official companion repo / site (code, notes, exercises)
// Books not listed here fall back to a web search in interact.js.
export const BOOK_LINKS = {
  // ---- machine learning / deep learning ----
  'Deep Learning': { url: 'https://www.deeplearningbook.org/', kind: 'free' },
  'Dive into Deep Learning': { url: 'https://d2l.ai/', kind: 'free' },
  'Understanding Deep Learning': { url: 'https://udlbook.github.io/udlbook/', kind: 'free' },
  'Deep Learning: Foundations and Concepts': { url: 'https://www.bishopbook.com/', kind: 'free' },
  'Pattern Recognition and Machine Learning': { url: 'https://www.microsoft.com/en-us/research/people/cmbishop/prml-book/', kind: 'free' },
  'Probabilistic Machine Learning': { url: 'https://probml.github.io/pml-book/', kind: 'free' },
  'Reinforcement Learning: An Introduction': { url: 'http://incompleteideas.net/book/the-book-2nd.html', kind: 'free' },
  'The Elements of Statistical Learning': { url: 'https://hastie.su.domains/ElemStatLearn/', kind: 'free' },
  '深度学习': { url: 'https://github.com/exacity/deeplearningbook-chinese', kind: 'free' },
  '动手学深度学习': { url: 'https://zh.d2l.ai/', kind: 'free' },
  '机器学习': { url: 'https://github.com/datawhalechina/pumpkin-book', kind: 'code' },
  '统计学习方法': { url: 'https://github.com/fengdu78/lihang-code', kind: 'code' },

  // ---- LLM / NLP ----
  'Hands-On Large Language Models': { url: 'https://github.com/HandsOnLLM/Hands-On-Large-Language-Models', kind: 'code' },
  'Build a Large Language Model (From Scratch)': { url: 'https://github.com/rasbt/LLMs-from-scratch', kind: 'code' },
  '大规模语言模型：从理论到实践': { url: 'https://intro-llm.github.io/', kind: 'free' },
  'Speech and Language Processing': { url: 'https://web.stanford.edu/~jurafsky/slp3/', kind: 'free' },
  'Natural Language Processing with Transformers': { url: 'https://github.com/nlp-with-transformers/notebooks', kind: 'code' },
  "LLM Engineer's Handbook": { url: 'https://github.com/PacktPublishing/LLM-Engineers-Handbook', kind: 'code' },
  'Generative Deep Learning': { url: 'https://github.com/davidADSP/Generative_Deep_Learning_2nd_Edition', kind: 'code' },

  // ---- graphics / GPU ----
  'Physically Based Rendering 4th Ed.': { url: 'https://pbr-book.org/4ed/contents', kind: 'free' },
  'GPU Gems': { url: 'https://developer.nvidia.com/gpugems/gpugems/foreword', kind: 'free' },
  'Ray Tracing Gems': { url: 'https://link.springer.com/book/10.1007/978-1-4842-4427-2', kind: 'free' },

  // ---- ML systems / infra ----
  'Designing Machine Learning Systems': { url: 'https://github.com/chiphuyen/dmls-book', kind: 'code' },
  'AI Engineering': { url: 'https://github.com/chiphuyen/aie-book', kind: 'code' },
  '机器学习系统：设计和实现': { url: 'https://openmlsys.github.io/', kind: 'free' },
  'Site Reliability Engineering': { url: 'https://sre.google/sre-book/table-of-contents/', kind: 'free' },
  'Operating Systems: Three Easy Pieces': { url: 'https://pages.cs.wisc.edu/~remzi/OSTEP/', kind: 'free' },
  'Readings in Database Systems': { url: 'http://www.redbook.io/', kind: 'free' },

  // ---- algorithms ----
  'Algorithms 4th Ed.': { url: 'https://algs4.cs.princeton.edu/home/', kind: 'code' },
  'Algorithms': { url: 'https://jeffe.cs.illinois.edu/teaching/algorithms/', kind: 'free' },
};
