import { describe, it, expect } from 'vitest';
import { scoreIntentComplexity } from '../../src/llm/complexity.js';

describe('scoreIntentComplexity', () => {
  it('scores simple single-action intents low (< 4)', () => {
    expect(scoreIntentComplexity('turn off lights at 10pm')).toBeLessThan(4);
    expect(scoreIntentComplexity('open curtains every morning')).toBeLessThan(4);
    expect(scoreIntentComplexity('lock the door at midnight')).toBeLessThan(4);
  });

  it('scores multi-condition intents at 4 or higher', () => {
    expect(scoreIntentComplexity('if temperature > 28 and humidity > 70 turn on AC')).toBeGreaterThanOrEqual(4);
  });

  it('scores time-window intents at 4 or higher', () => {
    expect(scoreIntentComplexity('on weekdays between 9am and 6pm keep lights on')).toBeGreaterThanOrEqual(4);
  });

  it('scores complex multi-clause intents at 7 or higher', () => {
    const complex = 'on weekdays if someone opens the door and room temp is below 20 turn on AC but skip if AC is already on';
    expect(scoreIntentComplexity(complex)).toBeGreaterThanOrEqual(7);
  });

  it('returns a number in range 0-10', () => {
    const score = scoreIntentComplexity('any intent string here');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('cross-sensor intent scores high', () => {
    expect(scoreIntentComplexity('if temperature is high and humidity is also high run the fan')).toBeGreaterThanOrEqual(4);
  });
});
