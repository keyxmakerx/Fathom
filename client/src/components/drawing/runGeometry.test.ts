import { describe, expect, it } from 'vitest';

import { pointOnRun, projectOntoRun, rackRunLine, RUN_OFFSET_PX, runUnder, type RunSegment } from './runGeometry';

const box = { x: 100, y: 50, width: 300, headerPx: 16, frameHeight: 672 };

describe('where a run sits', () => {
  it('puts a lacing bar just outside the frame, top to bottom', () => {
    expect(rackRunLine(box, 'left')).toEqual({ vertical: true, x1: 100 - RUN_OFFSET_PX, y1: 66, x2: 100 - RUN_OFFSET_PX, y2: 738 });
    expect(rackRunLine(box, 'right').x1).toBe(400 + RUN_OFFSET_PX);
  });
  it('puts a tray above the rack, left to right', () => {
    expect(rackRunLine(box, 'top')).toEqual({ vertical: false, x1: 100, y1: 50 - RUN_OFFSET_PX, x2: 400, y2: 50 - RUN_OFFSET_PX });
    expect(rackRunLine(box, 'bottom').y1).toBe(738 + RUN_OFFSET_PX);
  });
  it('finds a tie by thousandths along the run, and back', () => {
    const line = rackRunLine(box, 'top');
    expect(pointOnRun(line, 500)).toEqual({ x: 250, y: 40 });
    expect(projectOntoRun(line, { x: 250, y: 45 })).toEqual({ at: 500, distance: 5 });
    expect(projectOntoRun(line, { x: 0, y: 40 }).at).toBe(0);
  });
});

describe('dropping a tie', () => {
  const runs: RunSegment[] = [
    { runId: 'left', hostId: 'r', ...rackRunLine(box, 'left') },
    { runId: 'top', hostId: 'r', ...rackRunLine(box, 'top') },
  ];
  it('clips onto the nearest run within reach', () => {
    expect(runUnder(runs, { x: 95, y: 402 })).toEqual({ run: runs[0], at: 500 });
    expect(runUnder(runs, { x: 250, y: 36 })?.run.runId).toBe('top');
  });
  it('clips onto nothing when dropped in open canvas', () => {
    expect(runUnder(runs, { x: 250, y: 400 })).toBeNull();
  });
});
