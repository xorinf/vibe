import {
  Wand2,
  Gauge,
  GaugeCircle,
  Languages,
  ListChecks,
  Lightbulb,
  Zap,
  MousePointerClick,
  Accessibility,
  Smartphone,
  Palette,
  Clock4,
  GitBranch,
  ListOrdered,
  Workflow,
  Beaker,
  Link2,
  ListTree,
  Timer,
  HelpCircle,
  type LucideIcon,
} from 'lucide-react';

/**
 * Quick-action chips that the teacher can drop into the chat without
 * typing. Each action expands to a natural-language instruction that
 * the SSE pipeline sends to the model. The server-side system prompt
 * already understands these labels (see IleGenerationService).
 *
 * Why a const map and not a free-form JSON config: the actions are
 * tightly coupled to the system prompt's heuristics. If we add a new
 * action here, we should also update the prompt. Keeping them in one
 * file makes that relationship obvious.
 */

export type QuickActionId =
  | 'improve'
  | 'simplify'
  | 'harder'
  | 'easier'
  | 'translate'
  | 'add-quiz'
  | 'add-hints'
  | 'add-animations'
  | 'more-visual'
  | 'convert-timeline'
  | 'convert-simulation'
  | 'optimize-mobile'
  | 'improve-accessibility'
  | 'add-timer'
  | 'make-interactive'
  | 'a11y'
  | 'mobile'
  | 'convert-flashcards'
  | 'convert-escape-room'
  | 'convert-decision-tree'
  | 'convert-lab'
  | 'convert-matching'
  | 'convert-flowchart';

export interface QuickAction {
  id: QuickActionId;
  label: string;
  icon: LucideIcon;
  instruction: string;
  /**
   * The action needs a target language if it's `translate`. Captured via
   * a follow-up prompt rather than a UI control — keeps the chip count
   * manageable.
   */
  needsFollowup?: 'language';
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'improve',
    label: 'Improve',
    icon: Wand2,
    instruction:
      'Polish the current experience. Tighten the visual hierarchy, refine the wording on labels, and smooth any rough edges. Keep every existing control and the overall lesson intent intact.',
  },
  {
    id: 'simplify',
    label: 'Simplify',
    icon: Gauge,
    instruction:
      'Simplify this experience. Remove any non-essential decoration or controls, tighten copy to plain language, and reduce visual noise. The lesson should still teach the same thing — just with less in the way.',
  },
  {
    id: 'harder',
    label: 'Increase difficulty',
    icon: GaugeCircle,
    instruction:
      'Increase the difficulty. Add challenge, time pressure, or a stretch goal on top of the current design. The same lesson, but students should have to push harder to complete it.',
  },
  {
    id: 'easier',
    label: 'Reduce difficulty',
    icon: Gauge,
    instruction:
      'Reduce the difficulty. Add a hint button, a worked example, or a slower initial step. The lesson stays the same but the entry point is gentler.',
  },
  {
    id: 'translate',
    label: 'Translate',
    icon: Languages,
    instruction: '', // Filled in once the teacher picks a target language
    needsFollowup: 'language',
  },
  {
    id: 'add-quiz',
    label: 'Add Quiz',
    icon: ListChecks,
    instruction:
      'Add a short multiple-choice quiz to this experience — 3 to 5 questions at the end, with instant feedback. Keep all existing controls and content; just append the quiz as a new section after the main interaction.',
  },
  {
    id: 'add-hints',
    label: 'Add Hints',
    icon: Lightbulb,
    instruction:
      'Add contextual hints. Each existing interactive control should get a "Hint" affordance that reveals a one-line nudge without giving away the answer. Don\'t redesign the layout — just add the hints.',
  },
  {
    id: 'add-animations',
    label: 'Add Animations',
    icon: Zap,
    instruction:
      'Add tasteful animations. Use CSS transitions / @keyframes — no libraries. Animate state changes, button presses, and the result of each interaction. Keep motion short (under 400ms) and respect prefers-reduced-motion.',
  },
  {
    id: 'more-visual',
    label: 'More Visual',
    icon: Palette,
    instruction:
      'Make the visual design more polished. Use a cohesive colour palette (no more than three hues plus neutrals), generous whitespace, and typographic hierarchy. Replace any placeholder emoji with SVG or simple shapes. Add subtle shadows or gradients. Keep all existing interactive logic — only the visual treatment changes.',
  },
  {
    id: 'convert-timeline',
    label: 'Convert to Timeline',
    icon: GitBranch,
    instruction:
      'Convert this experience into a horizontal or vertical timeline of key events. Each event has a date, a short title, a 1–2 sentence description, and a small icon. Add prev/next navigation.',
  },
  {
    id: 'convert-simulation',
    label: 'Convert to Simulation',
    icon: Workflow,
    instruction:
      'Convert this experience into a step-by-step interactive simulation. The student progresses through 3–5 scenes, each with controls they can manipulate to see the outcome. Include a "Restart" button and a short caption per scene.',
  },
  {
    id: 'add-timer',
    label: 'Add Timer',
    icon: Timer,
    instruction:
      'Add a configurable timer (e.g. 60-second countdown with start/pause/reset) that fits naturally into the existing interaction. Use a clear monospaced readout. When the timer hits zero, surface a "Time\'s up" state without auto-resetting.',
  },
  {
    id: 'make-interactive',
    label: 'Make Interactive',
    icon: MousePointerClick,
    instruction:
      'Make this experience more interactive. Convert any passive text or static diagrams into drag, click, or slider-based interactions. Aim for at least three distinct interactions the student can perform.',
  },
  {
    id: 'a11y',
    label: 'Improve Accessibility',
    icon: Accessibility,
    instruction:
      'Improve accessibility. Add proper labels, ARIA where appropriate, keyboard navigation, visible focus states, and ensure colour contrast meets WCAG AA. Do not change the lesson content.',
  },
  {
    id: 'mobile',
    label: 'Improve Mobile Layout',
    icon: Smartphone,
    instruction:
      'Improve the mobile layout. Stack controls vertically, increase touch targets to at least 44px, reflow text, and make sure nothing overflows on a 375px-wide screen. Desktop layout can stay the same.',
  },
];

/**
 * Prompt library — full-template starters the teacher can drop in.
 * Divided into the same categories the brief lists. Each entry
 * produces a complete, lesson-ready HTML document rather than a
 * tweak to the current draft.
 */
export interface PromptTemplate {
  id: string;
  label: string;
  icon: LucideIcon;
  category: 'lesson' | 'tutorial' | 'assessment' | 'simulation';
  /**
   * The full prompt sent to the model. Pre-pended with the current
   * document so the model edits rather than starts from scratch
   * (the workspace always includes a "<current>…</current>" wrap).
   */
  prompt: string;
}

export const PROMPTLibrary: PromptTemplate[] = [
  {
    id: 'lesson-timeline',
    label: 'Timeline',
    icon: GitBranch,
    category: 'lesson',
    prompt:
      'Convert this into a horizontal/vertical timeline that walks the student through key historical or conceptual events. Each event should have a date, a short title, a 1–2 sentence description, and a small icon. Add prev/next navigation. Keep the existing lesson content where relevant but the timeline should be the primary navigation surface.',
  },
  {
    id: 'lesson-flashcards',
    label: 'Flashcards',
    icon: ListOrdered,
    category: 'lesson',
    prompt:
      'Convert this into a flashcard deck (5–10 cards). Each card has a question or term on the front and a short answer on the back. Support keyboard navigation (Space to flip, ←/→ to move, R to reset). Show a progress indicator and a "shuffle" button.',
  },
  {
    id: 'sim-lab',
    label: 'Lab',
    icon: Beaker,
    category: 'simulation',
    prompt:
      'Convert this into a virtual lab. The student should be able to set inputs (sliders, dropdowns, or text fields) and see the calculated result. Show step-by-step reasoning or a formula. Include a "Reset" button and a clear input/output layout.',
  },
  {
    id: 'sim-flowchart',
    label: 'Flowchart',
    icon: Workflow,
    category: 'simulation',
    prompt:
      'Convert this into an interactive flowchart. Each node should be a clickable step; the student progresses through the flow by clicking "Next". Highlight the current node, dim the others, and include a "Back" button. Use SVG or absolutely-positioned divs for the layout.',
  },
  {
    id: 'sim-decision-tree',
    label: 'Decision Tree',
    icon: ListTree,
    category: 'simulation',
    prompt:
      'Convert this into a guided decision tree. The student answers yes/no or multiple-choice questions and progresses through branches to a recommendation. Show their path so far and let them go back to change an answer.',
  },
  {
    id: 'sim-escape-room',
    label: 'Escape Room',
    icon: HelpCircle,
    category: 'simulation',
    prompt:
      'Convert this into a mini escape room puzzle. The student has 3–4 sequential puzzles (a riddle, a code, a logic puzzle, a hidden-clue reveal). Each unlocks the next; show a timer and a "hint" button per puzzle; show a celebration screen on completion.',
  },
  {
    id: 'assess-quiz',
    label: 'Quiz',
    icon: ListChecks,
    category: 'assessment',
    prompt:
      'Convert this into a 5-question multiple-choice quiz. Each question has 4 options, instant feedback (correct/incorrect with explanation), and a final score screen. Track which questions the student got wrong and show them again at the end as a "Review" section.',
  },
  {
    id: 'assess-matching',
    label: 'Matching',
    icon: Link2,
    category: 'assessment',
    prompt:
      'Convert this into a matching exercise. Two columns of items; the student draws or clicks to connect pairs. Show correct/incorrect feedback on each connection and a final score. Works for vocabulary (term ↔ definition), symbols ↔ names, or causes ↔ effects.',
  },
  {
    id: 'tutorial-simulation',
    label: 'Simulation',
    icon: Workflow,
    category: 'tutorial',
    prompt:
      'Convert this into a step-by-step interactive simulation. The student progresses through 3–5 scenes, each with controls they can manipulate to see the outcome. Include a "Restart" button and a short caption per scene explaining what the student is observing.',
  },
  {
    id: 'tutorial-typing',
    label: 'Walkthrough',
    icon: Timer,
    category: 'tutorial',
    prompt:
      'Convert this into a guided walkthrough. The student sees one step at a time, types or clicks to advance, and gets feedback on each answer. Include a progress bar, an estimated time, and a final summary.',
  },
];

export const QUICK_ACTIONS_BY_ID: Record<QuickActionId, QuickAction> =
  QUICK_ACTIONS.reduce(
    (acc, action) => {
      acc[action.id] = action;
      return acc;
    },
    {} as Record<QuickActionId, QuickAction>,
  );

/**
 * Build the actual instruction string sent to the model. The translate
 * action is special — we need the target language before we can ask
 * the model to do anything useful.
 */
export function resolveInstruction(
  id: QuickActionId,
  followupValue?: string,
): string | null {
  const action = QUICK_ACTIONS_BY_ID[id];
  if (!action) return null;
  if (action.needsFollowup === 'language') {
    const lang = (followupValue ?? '').trim();
    if (!lang) return null;
    return `Translate every user-facing string in this experience to ${lang}. Preserve the layout, interactions, and lesson structure exactly. Only the visible text changes.`;
  }
  return action.instruction;
}