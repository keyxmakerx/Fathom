// The QR encoder and the one component that draws it (ADR-0056 decision 5).
// Written 2026-09-22.

export { QrTooLongError, encodeQr, type QrSymbol } from './encode';
export { QrCode, type QrCodeProps } from './QrCode';
export { QR_QUIET_ZONE, qrPath, qrSide } from './svg';
