/*
  modes.js — Single source of truth for PromptBench's improvement modes
  AND its prompt-enhancement methodology.

  Loaded as a plain classic script (not an ES module) so that THREE very
  different contexts can all read the same data without a build step:
    - content.js       (runs on the chat page — builds the mode menu)
    - popup/popup.js    (runs in the settings popup — builds the dropdown)
    - service-worker.js (runs in the background — builds the Gemini prompts)

  Python analogy: this is like a `constants.py` that three different
  scripts each do `from constants import PB_MODES` on. In the browser we
  don't have that import syntax for classic scripts, so instead:
    - content_scripts and popup.html just load this file with a <script>
      tag BEFORE the file that uses it, and the globals below become
      normal global variables both files can see (same trick as loading
      jQuery before your own script.js).
    - the background service worker uses `importScripts('modes.js')`,
      which is the classic-script equivalent of an import for workers.

  ── HOW THE ENHANCEMENT ENGINE IS STRUCTURED ─────────────────────────────
  Earlier versions of this file gave every mode its own fully independent
  system prompt. That produced flat, "caveman-ish" rewrites (mechanically
  bullet-ifying everything) and made every mode drift further from the
  others as prompts got hand-tuned one at a time.

  Instead, PB_BASE_INSTRUCTION below is the actual methodology: understand
  the user's real goal, find what's genuinely holding the prompt back, add
  ONLY the structure that specific task benefits from, and never bloat or
  invent things the user didn't ask for. Every mode shares that exact same
  methodology. What differs per mode is just a short `lens` — a couple of
  sentences telling the model which dimension of a prompt to pay the most
  attention to (technical rigor for code, pedagogy for learning, etc).
  service-worker.js concatenates base + lens into the final instruction it
  sends to Gemini. One methodology, seven lenses — not seven methodologies.
*/

// ── THE METHODOLOGY (shared by every mode) ──────────────────────────────
const PB_BASE_INSTRUCTION =
  'You are an expert prompt engineer. Rewrite the user\'s prompt so it ' +
  'reliably gets a substantially better response from an AI assistant — ' +
  'not so it merely looks longer, more formal, or more elaborate.\n\n' +

  'First, understand what the user is actually trying to accomplish: ' +
  'their goal, their tone, and any constraints they stated or clearly ' +
  'implied. Preserve all of that exactly. Never change the underlying ' +
  'task, swap in a different approach the user didn\'t ask for, or add ' +
  'requirements, facts, technologies, or preferences the user did not ' +
  'state or reasonably imply.\n\n' +

  'Then find what\'s actually holding the prompt back: ambiguous wording, ' +
  'missing context an AI would need, vague or conflicting instructions, ' +
  'or no clear sense of what a good answer looks like. Distinguish ' +
  'between information that is genuinely missing (worth flagging as an ' +
  'assumption, or asking the model to check) and information you can ' +
  'reasonably infer from context — don\'t manufacture false specificity.\n\n' +

  'Improve the prompt using whichever combination of role/context, a ' +
  'clearly stated objective, concrete instructions, relevant constraints, ' +
  'important edge cases, and an appropriate output format actually helps ' +
  'THIS request — chosen by what kind of task it is, not from a fixed ' +
  'checklist applied to everything. Do not add a section just to make ' +
  'the prompt look sophisticated. A prompt that\'s already fairly clear ' +
  'may only need one small, targeted addition, not a full rewrite — a ' +
  'short prompt improved well can still be short. If the task genuinely ' +
  'benefits from careful step-by-step reasoning, instruct the model to ' +
  'reason it through and report its conclusions, key assumptions, or a ' +
  'brief self-check — never to dump its raw internal reasoning.\n\n' +

  'Before you finish, check yourself: does the rewritten prompt still ' +
  'ask for exactly what the user originally wanted, and does every ' +
  'sentence you added meaningfully raise the odds of getting that ' +
  'result? Cut anything that doesn\'t pass that test.\n\n' +

  'Return ONLY the improved prompt text — no preamble, no explanation, ' +
  'no labels, no markdown headers wrapping it.';

// ── THE MODES (each just a lens on the same methodology) ────────────────
const PB_MODES = [
  {
    value: 'clearer',
    icon: '🎯',
    label: 'Clearer',
    hint: 'Sharper, unambiguous wording',
    lens:
      'For this rewrite, focus purely on precision: eliminate vague or ' +
      'ambiguous phrasing and resolve anything that could be read two ' +
      'ways. Don\'t add scope the user didn\'t ask for — just make their ' +
      'existing ask unambiguous.',
  },
  {
    value: 'detailed',
    icon: '📋',
    label: 'Detailed',
    hint: 'Add context, constraints & format',
    lens:
      'For this rewrite, focus on filling in the context an AI would ' +
      'actually need but wasn\'t given — relevant background, ' +
      'constraints, and what the output should look like. Add depth ' +
      'where it changes the answer, not padding that doesn\'t.',
  },
  {
    value: 'professional',
    icon: '💼',
    label: 'Professional',
    hint: 'Formal tone for business or academic use',
    lens:
      'For this rewrite, focus on tone and structure suited to a formal, ' +
      'business or academic setting — precise language, sensible ' +
      'structure, no casual phrasing — while keeping the underlying ask ' +
      'identical.',
  },
  {
    value: 'creative',
    icon: '✍️',
    label: 'Creative',
    hint: 'Richer voice, tone & storytelling',
    lens:
      'For this rewrite, focus on unlocking a more distinctive response: ' +
      'encourage voice, sensory detail, and narrative shape where the ' +
      'request calls for it, with open-ended imaginative framing rather ' +
      'than a rigid brief.',
  },
  {
    value: 'coding',
    icon: '💻',
    label: 'Coding',
    hint: 'Language, edge cases & style rules',
    lens:
      'For this rewrite, focus on what a coding assistant needs to ' +
      'produce correct, usable code: the language or framework (state ' +
      'it if implied but unstated), relevant edge cases and error ' +
      'handling, any style or convention constraints, and whether tests ' +
      'or usage examples are expected. Don\'t invent a tech stack the ' +
      'user didn\'t imply.',
  },
  {
    value: 'learning',
    icon: '🎓',
    label: 'Learning',
    hint: 'Step-by-step with analogies',
    lens:
      'For this rewrite, focus on how the answer should be taught, not ' +
      'just what\'s asked: request a step-by-step explanation with ' +
      'concrete analogies for unfamiliar ideas, and a brief check-in (a ' +
      'follow-up question or short recap) so the learner can confirm ' +
      'they followed it.',
  },
  {
    value: 'research',
    icon: '🔬',
    label: 'Research',
    hint: 'Citations, methodology & rigor',
    lens:
      'For this rewrite, focus on analytical rigor: ask for credible ' +
      'sources or evidence where relevant, a clear line of reasoning or ' +
      'methodology, and acknowledgment of limitations or ' +
      'counterarguments — proportional to how deep the original request ' +
      'actually calls for.',
  },
];

// Look up a mode by its value, falling back to the first mode ("clearer")
// if the stored value is missing or stale (e.g. from an older version).
// Python analogy: like `MODES.get(value, MODES[0])` on a dict.
function pbGetMode(value) {
  return PB_MODES.find((m) => m.value === value) || PB_MODES[0];
}


/* ════════════════════════════════════════════════════════════════════════
   v0.5 ADDITIONS — see SPEC-v0.5.md for the full design rationale behind
   every constant below. Nothing above this line changed for v0.5; the
   whole point of putting the methodology in modes.js was so new
   capabilities could be added as new exported constants without touching
   PB_BASE_INSTRUCTION or PB_MODES at all.
   ════════════════════════════════════════════════════════════════════════ */

// ── FEATURE 2: THREAD-CONTEXTUAL PROMPT IMPROVEMENT ─────────────────────
// When content.js finds prior conversation turns on the page, service-
// worker.js uses THIS opening instruction instead of PB_BASE_INSTRUCTION's
// opening — it's the same methodology plus explicit rules for how to use
// the conversation history it's about to be given. See SPEC-v0.5.md §3.4.
const PB_CONTEXT_BASE_INSTRUCTION =
  'You are improving a prompt that the user is about to send INSIDE AN ' +
  'ONGOING CONVERSATION. Below the prompt, you are given the most recent ' +
  'prior turns of that conversation, oldest first. Use them the way a ' +
  'careful human editor would use conversation history: to understand ' +
  'what\'s already been established, so the improved prompt fits ' +
  'naturally as the next message rather than repeating context the ' +
  'assistant already has.\n\n' +

  'Rules for using the conversation history:\n' +
  '1. Do not restate, summarize, or re-explain information already ' +
  'covered in the prior turns — assume the assistant remembers its own ' +
  'conversation.\n' +
  '2. If an earlier turn stated a constraint, format, persona, or ' +
  'ongoing task (a target audience, a required output format, a ' +
  'language, a length limit, a rule like \'always cite sources\'), ' +
  'preserve that constraint in the improved prompt if the new request ' +
  'doesn\'t override it — do not silently drop standing instructions.\n' +
  '3. If the new prompt is ambiguous on its own but the ongoing ' +
  'conversation makes the intent clear (e.g. \'do the same thing for the ' +
  'second one\'), resolve that ambiguity using the context — but do not ' +
  'invent details the conversation doesn\'t support.\n' +
  '4. If the conversation history looks unrelated to the new prompt (the ' +
  'user changed topics), do not force a connection — improve the new ' +
  'prompt on its own merits and ignore the unrelated history.\n' +
  '5. Never quote the raw conversation history back verbatim inside the ' +
  'improved prompt merely to prove it was read — only fold in the ' +
  'specific details that make the new prompt clearer or more complete.\n\n' +

  'Conversation history (oldest first):\n{{THREAD_HISTORY_BLOCK}}\n\n' +

  'Then apply the same standard you always would: fix ambiguity, add ' +
  'only the structure this specific request benefits from, never invent ' +
  'facts or requirements the user didn\'t state or imply, and return ' +
  'ONLY the improved prompt text — no preamble, no labels.';

// Budget constants for assembling {{THREAD_HISTORY_BLOCK}} — see
// SPEC-v0.5.md §3.3 for why these specific numbers. Exported so
// content.js and service-worker.js (which run in different contexts, but
// both load modes.js) share a single source of truth for the budget,
// exactly like PB_MODES already is for the mode list.
const PB_CONTEXT_MAX_TURNS = 6;          // messages, not pairs
const PB_CONTEXT_MAX_CHARS_PER_TURN = 1000;
const PB_CONTEXT_MAX_TOTAL_CHARS = 6000;


// ── FEATURE 3: SPECIALIZED CREATIVE & IMAGE GENERATION MODE ─────────────
// Image mode is its own small state machine (task + target) layered next
// to the ordinary PB_MODES list — see SPEC-v0.5.md §4.2 for why it isn't
// just an 8th flat entry in PB_MODES.
const PB_IMAGE_MODE_VALUE = 'image';

// A stand-in "mode" object with the same {value, icon, label} shape as a
// real PB_MODES entry, used wherever content.js needs `currentMode` to
// represent image mode. Deliberately NOT added to the PB_MODES array
// itself (see §4.2's rationale for why image mode is its own state
// machine) — which means pbGetMode(PB_IMAGE_MODE_VALUE) would NOT find
// it and would silently fall back to PB_MODES[0] instead. Anywhere that
// needs to SET the active mode to image mode must use this constant
// directly, never pbGetMode('image').
const PB_IMAGE_PSEUDO_MODE = { value: PB_IMAGE_MODE_VALUE, icon: '🎨', label: 'Image', hint: 'Generate or edit an image prompt' };

const PB_IMAGE_TASKS = [
  { value: 'generate', icon: '🖼️', label: 'New Generation', hint: 'Describe a new image from scratch' },
  { value: 'edit', icon: '🩹', label: 'Targeted Edit', hint: 'Change one part of an existing image' },
];

const PB_IMAGE_TARGETS = [
  { value: 'midjourney', label: 'Midjourney' },
  { value: 'dalle', label: 'DALL·E' },
  { value: 'sd', label: 'Stable Diffusion' },
  { value: 'generic', label: 'Generic / Other' },
];

function pbGetImageTask(value) {
  return PB_IMAGE_TASKS.find((t) => t.value === value) || PB_IMAGE_TASKS[0];
}

function pbGetImageTarget(value) {
  return PB_IMAGE_TARGETS.find((t) => t.value === value) || PB_IMAGE_TARGETS[0];
}

// New Generation: expand a rough idea into a structured generation prompt.
// See SPEC-v0.5.md §4.3 — this deliberately mirrors PB_BASE_INSTRUCTION's
// "never invent facts the user didn't state or imply" rule, applied to
// visual specifics instead of textual ones.
const PB_IMAGE_GENERATE_INSTRUCTION =
  'You are rewriting a rough idea into a detailed, well-structured image ' +
  'generation prompt for an AI image model. Expand it using this ' +
  'checklist, including a line ONLY when the original idea supports it ' +
  '— do not invent specific details (exact colors, brand names, a real ' +
  'person\'s likeness, a specific living artist\'s name) that the user ' +
  'did not ask for or clearly imply:\n\n' +
  '- Subject: the main focal element(s), specific enough to render ' +
  'unambiguously.\n' +
  '- Setting / composition: where the scene takes place and how it\'s ' +
  'framed (foreground/background, camera angle, distance).\n' +
  '- Style / medium: e.g. photograph, oil painting, 3D render, flat ' +
  'vector illustration — keep whatever medium the user implied; don\'t ' +
  'default to photorealism if they didn\'t ask for it.\n' +
  '- Lighting and color palette: only if implied or clearly beneficial ' +
  'to state explicitly.\n' +
  '- Mood / atmosphere: one short phrase, only if it adds real ' +
  'information beyond what the subject/setting already convey.\n' +
  '- Technical parameters: aspect ratio, level of detail, or similar — ' +
  'only if the user stated or clearly implied one.\n\n' +
  'Do not add people, text, logos, or watermarks the user didn\'t ask ' +
  'for. Do not soften or remove anything the user explicitly requested, ' +
  'even if it is unusual or highly specific — your job is to add ' +
  'structure and clarity, not to edit their creative intent.\n\n' +
  'Output only the finished prompt text (plus platform-specific ' +
  'parameters per the formatting rules below) — no preamble, no ' +
  'explanation.';

// Targeted Edit (inpainting/masking): see SPEC-v0.5.md §4.4. This is the
// highest-precision prompt in the whole extension — it forces a labeled,
// two-part output specifically so "what changes" and "what must not
// change" can never blur together into one paragraph the image model
// might apply inconsistently.
const PB_IMAGE_EDIT_INSTRUCTION =
  'You are rewriting an instruction for a TARGETED EDIT to an existing ' +
  'image (inpainting/masking-style edit) — NOT a new image, and NOT a ' +
  'full regeneration. The user will describe what they want changed, ' +
  'sometimes loosely. Your job is to produce a precise edit instruction ' +
  'with two clearly separated parts, using EXACTLY this structure:\n\n' +
  'EDIT TARGET:\n' +
  '[One or two sentences naming the SPECIFIC region or element to ' +
  'change — by location and/or subject, e.g. \'the sky in the ' +
  'background\', \'the character\'s jacket\', \'the text on the sign in ' +
  'the lower right\'. State exactly what it should become. Be as ' +
  'spatially specific as the user\'s request allows.]\n\n' +
  'PRESERVE UNCHANGED:\n' +
  '[An explicit statement that everything NOT named above — subject ' +
  'identity and pose, composition and framing, background elements not ' +
  'mentioned, art style, color grading, and lighting — must remain ' +
  'exactly as in the original image. Name the specific unedited ' +
  'elements you can infer are present so this reads as a real ' +
  'constraint, not a generic disclaimer.]\n\n' +
  'Rules:\n' +
  '1. If the request is ambiguous about scope, use the MINIMAL faithful ' +
  'interpretation — do not expand a small requested change into a ' +
  'larger one.\n' +
  '2. If the request requires a secondary effect outside the named edit ' +
  'target to make visual sense (e.g. \'change it to nighttime\' implies ' +
  'lighting changes beyond just the sky), name that explicitly in EDIT ' +
  'TARGET rather than hiding it or silently expanding scope elsewhere.\n' +
  '3. Never use this mode to request a change to a real, identifiable ' +
  'person\'s likeness in a way that could misrepresent them — if the ' +
  'request appears to be that, build the template around only the ' +
  'non-identity aspects of the request and omit any likeness ' +
  'instruction, rather than silently complying.\n' +
  '4. Do not add stylistic embellishments the user didn\'t ask for — a ' +
  'targeted edit prompt\'s job is precision, not creativity.\n\n' +
  'Output ONLY the two labeled sections above, then apply the target ' +
  'platform\'s formatting rules below to their combined content.';

// Per-target-platform "lenses" — same append-after-base pattern as
// PB_MODES' `lens` field, just keyed by PB_IMAGE_TARGETS value instead of
// a mode value. Isolating platform syntax here means a future change to,
// say, Midjourney's parameter flags is a one-string edit in this file —
// see SPEC-v0.5.md §4.5, edge case 4.
const PB_IMAGE_LENSES = {
  midjourney:
    'Format for Midjourney: write the descriptive prompt as flowing ' +
    'comma-separated phrases (not full sentences), then append ' +
    'Midjourney parameters at the very end in the same message, e.g. ' +
    '--ar 16:9 for aspect ratio, --style raw for a literal rendering, ' +
    '--v 6 for the model version, --no <term> to exclude something ' +
    'instead of a separate negative prompt. Only include parameters the ' +
    'request implies a need for — do not append a full parameter block ' +
    'by default.',
  dalle:
    'Format for DALL·E: write the prompt as clear, literal ' +
    'natural-language sentences (DALL·E follows plain descriptive ' +
    'language better than comma-keyword lists, and has no ' +
    'negative-prompt syntax — express exclusions as positive statements ' +
    'instead, e.g. \'an empty street\' rather than \'street, no cars\'). ' +
    'Do not include parameter flags.',
  sd:
    'Format for Stable Diffusion: write the prompt as comma-separated ' +
    'weighted tags (most important terms first), and produce a SEPARATE ' +
    'negative prompt line beginning \'Negative prompt:\' listing things ' +
    'to avoid — only if the request context makes that relevant, don\'t ' +
    'pad with boilerplate. Do not invent LoRA names, model checkpoints, ' +
    'or sampler settings the user did not mention.',
  generic:
    'Format for general use: write the prompt as clear natural-language ' +
    'description with no platform-specific parameter syntax, so it can ' +
    'be adapted to any image tool.',
};


// ── FEATURE 1: FAVORITE PROMPTS — AUTO-TITLE SUGGESTION ─────────────────
// One short, cheap Gemini call (message type SUGGEST_TITLE in
// service-worker.js) fired only when the user explicitly clicks
// "✨ Suggest" while saving a favorite — see SPEC-v0.5.md §2.6 for why
// this is opt-in rather than automatic.
const PB_TITLE_SUGGEST_INSTRUCTION =
  'You will be given the text of a saved prompt template. Produce a ' +
  'short, literal, descriptive title for it — 3 to 7 words, no ' +
  'punctuation at the end, no quotation marks around it, title case. ' +
  'The title must describe what the prompt DOES or asks for, not ' +
  'restate it verbatim. Do not invent a category or add commentary. ' +
  'Output ONLY the title text, nothing else.';
