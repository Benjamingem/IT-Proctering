const REPEAT_WINDOW_MS = 5000;
const MIN_POINTER_DISTANCE = 16;
const MIN_POINTER_SAMPLE_MS = 250;

function directionFor(dx, dy) {
  return (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
}

function repeatedDirectionPattern(samples, now, windowMs) {
  for (let patternLength = 1; patternLength <= 3; patternLength += 1) {
    const sampleCount = Math.max(6, patternLength * 3);
    if (samples.length < sampleCount) continue;
    const recent = samples.slice(-sampleCount);
    if (now - recent[0].at < windowMs) continue;
    const pattern = recent.slice(0, patternLength).map((sample) => sample.direction);
    if (recent.every((sample, index) => sample.direction === pattern[index % patternLength])) return pattern;
  }
  return null;
}

export function createActivityTracker({ now = () => Date.now(), repeatWindowMs = REPEAT_WINDOW_MS } = {}) {
  let lastActivityAt = now();
  let lastPointer = null;
  let movementSamples = [];
  let clickTarget = null;
  let clickCount = 0;
  let clickStartedAt = 0;
  let heldTarget = null;
  let heldStartedAt = 0;
  let repetitiveInput = false;
  let repetitiveKind = null;
  let repetitiveTarget = null;
  let repetitivePattern = null;
  let repetitivePatternPosition = 0;

  function resetPatterns() {
    movementSamples = [];
    clickTarget = null;
    clickCount = 0;
    clickStartedAt = 0;
    repetitiveInput = false;
    repetitiveKind = null;
    repetitiveTarget = null;
    repetitivePattern = null;
    repetitivePatternPosition = 0;
  }

  function noteKeyboardActivity(at = now()) {
    lastActivityAt = at;
    lastPointer = null;
    heldTarget = null;
    resetPatterns();
  }

  function notePointerMove(x, y, at = now()) {
    if (!lastPointer) {
      lastPointer = { x, y, at };
      return;
    }
    const dx = x - lastPointer.x;
    const dy = y - lastPointer.y;
    if (Math.hypot(dx, dy) < MIN_POINTER_DISTANCE || at - lastPointer.at < MIN_POINTER_SAMPLE_MS) return;

    const direction = directionFor(dx, dy);
    lastPointer = { x, y, at };

    if (repetitiveInput) {
      if (repetitiveKind === 'movement' && repetitivePattern[repetitivePatternPosition % repetitivePattern.length] === direction) {
        repetitivePatternPosition += 1;
        return;
      }
      lastActivityAt = at;
      heldTarget = null;
      resetPatterns();
    }

    lastActivityAt = at;
    clickTarget = null;
    clickCount = 0;
    if (movementSamples.length && at - movementSamples.at(-1).at > repeatWindowMs) movementSamples = [];
    movementSamples.push({ direction, at });
    movementSamples = movementSamples.slice(-12);
    const pattern = repeatedDirectionPattern(movementSamples, at, repeatWindowMs);
    if (pattern) {
      repetitiveInput = true;
      repetitiveKind = 'movement';
      repetitivePattern = pattern;
      repetitivePatternPosition = movementSamples.length % pattern.length;
    }
  }

  function notePointerDown(target, at = now()) {
    const continuingRepeatedClick = repetitiveInput && repetitiveKind === 'click' && target === repetitiveTarget;
    const continuingClickSeries = clickTarget === target && clickCount > 0;
    if (!continuingRepeatedClick && !continuingClickSeries) {
      lastActivityAt = at;
      lastPointer = null;
      resetPatterns();
    }
    heldTarget = target;
    heldStartedAt = at;
  }

  function notePointerUp(target, at = now()) {
    if (heldTarget && at - heldStartedAt >= repeatWindowMs) {
      repetitiveInput = true;
      repetitiveKind = 'hold';
      repetitiveTarget = heldTarget;
    }
    heldTarget = null;
  }

  function noteClick(target, at = now()) {
    const continuingRepeatedClick = repetitiveInput && ['click', 'hold'].includes(repetitiveKind) && target === repetitiveTarget;
    if (repetitiveInput && !continuingRepeatedClick) {
      lastActivityAt = at;
      lastPointer = null;
      resetPatterns();
    }
    if (target === clickTarget) {
      clickCount += 1;
    } else {
      clickTarget = target;
      clickCount = 1;
      clickStartedAt = at;
    }
    if (!continuingRepeatedClick) lastActivityAt = at;
    if (clickCount >= 3 && at - clickStartedAt >= repeatWindowMs) {
      repetitiveInput = true;
      repetitiveKind = 'click';
      repetitiveTarget = target;
    }
  }

  function getState(at = now()) {
    if (heldTarget && at - heldStartedAt >= repeatWindowMs) {
      repetitiveInput = true;
      repetitiveKind = 'hold';
      repetitiveTarget = heldTarget;
    }
    return {
      idleSeconds: Math.max(0, Math.floor((at - lastActivityAt) / 1000)),
      repetitiveInput
    };
  }

  return { getState, noteClick, noteKeyboardActivity, notePointerDown, notePointerMove, notePointerUp };
}