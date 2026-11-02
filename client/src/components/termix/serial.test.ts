import { expect, it } from 'vitest';

import { SPEED_PLACEHOLDER, serialWays } from './serial';

it('gives PuTTY, screen and picocom lines with the port’s speed, as each program’s manual spells them', () => {
  expect(serialWays(9600).map((w) => w.command)).toEqual(['putty.exe -serial COM3 -sercfg 9600', 'screen /dev/ttyUSB0 9600', 'picocom -b 9600 /dev/ttyUSB0']);
});

it('says <speed> where nobody has given one, rather than guessing', () => {
  expect(serialWays(undefined).every((w) => w.command.includes(SPEED_PLACEHOLDER))).toBe(true);
});
