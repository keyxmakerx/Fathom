// r116 (ADR-0091 decision 3): a double-click goes in. A device or a shelf opens; a rack fits to the view; a port
// or a cable, having no inside, opens its panel. Pure, so the table is tested and the canvas reads from it.

export type DoubleClickKind = 'device' | 'shelf' | 'rack' | 'port' | 'cable';
export type DoubleClickAnswer = 'open' | 'fit' | 'panel';

export function doubleClickAnswer(kind: DoubleClickKind): DoubleClickAnswer {
  switch (kind) {
    case 'device':
    case 'shelf':
      return 'open';
    case 'rack':
      return 'fit';
    case 'port':
    case 'cable':
      return 'panel';
  }
}
