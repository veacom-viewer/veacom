// The plan as one printable picture (PNG, A4 in proportion): the film as planned, and the simulated correction when
// there is one, beside every value with its normal range, the calibration and the side. The pictures are the panes as
// the reader sees them (export-video.ts captureViewportCanvas), so the report shows what was checked on screen.
import type { Series } from '../model';
import { t as translateDefault } from '../i18n';
import { calibrationText, sideText } from '../imaging/radiograph';
import { topLeftLines, topRightLines } from './overlayCorners';

/**
 * The report's lines under its title: who and when, what film, by the pane's own corner rules (overlayCorners.ts), so
 * a report made with patient data hidden carries no name, date or description either; then the side and calibration.
 */
export function reportHeader(series: Series, frame: Series, hidePatient: boolean, translate = translateDefault): string[] {
  const left = topLeftLines(series, hidePatient, translate).map(line => line.text).join(' · ');
  const right = topRightLines(series, hidePatient, undefined, translate).map(line => line.text).join(' · ');
  return [left, right, `${sideText(frame)} · ${calibrationText(frame)}`].filter(Boolean);
}

export interface ReportSection { title: string; rows: Array<[string, string, string?]> }
export interface ReportContent { title: string; lines: string[]; pictures: Array<{ caption: string; canvas: HTMLCanvasElement }>; sections: ReportSection[]; footer: string[] }

const PAGE = { width: 2480, height: 3508 }; // A4 at 300 dpi
const MARGIN = 120, TEXT = '#111418', MUTED = '#4a5361', RULE = '#c9ced6';

export function drawReport(content: ReportContent): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE.width; canvas.height = PAGE.height;
  const context = canvas.getContext('2d', { alpha: false })!;
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, PAGE.width, PAGE.height);
  const font = (size: number, weight = 400) => `${weight} ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
  let y = MARGIN + 40;
  context.fillStyle = TEXT; context.font = font(60, 600); context.fillText(content.title, MARGIN, y);
  y += 56; context.font = font(34); context.fillStyle = MUTED;
  for (const line of content.lines) { context.fillText(line, MARGIN, y, PAGE.width - 2 * MARGIN); y += 46; }
  y += 16;
  // Pictures on the left half, the values on the right.
  const pictureWidth = (PAGE.width - 2 * MARGIN) * 0.5 - 30, top = y;
  let pictureY = top;
  const room = PAGE.height - top - 260;
  const each = content.pictures.length ? room / content.pictures.length : 0;
  for (const picture of content.pictures) {
    const scale = Math.min(pictureWidth / picture.canvas.width, (each - 60) / picture.canvas.height);
    const width = picture.canvas.width * scale, height = picture.canvas.height * scale;
    context.fillStyle = '#000'; context.fillRect(MARGIN, pictureY, width, height);
    context.drawImage(picture.canvas, MARGIN, pictureY, width, height);
    context.fillStyle = MUTED; context.font = font(30, 500); context.fillText(picture.caption, MARGIN, pictureY + height + 40);
    pictureY += each;
  }
  const left = MARGIN + (content.pictures.length ? pictureWidth + 60 : 0), width = PAGE.width - MARGIN - left;
  y = top + 20;
  for (const section of content.sections) {
    if (y > PAGE.height - 300) break;
    context.fillStyle = TEXT; context.font = font(38, 600); context.fillText(section.title, left, y); y += 18;
    context.strokeStyle = RULE; context.lineWidth = 2; context.beginPath(); context.moveTo(left, y); context.lineTo(left + width, y); context.stroke();
    y += 44;
    for (const [label, value, normal] of section.rows) {
      context.font = font(31, 500); context.fillStyle = TEXT; context.fillText(label, left, y, width * 0.34);
      context.font = font(31); context.fillText(value, left + width * 0.36, y, width * 0.34);
      if (normal) { context.fillStyle = MUTED; context.font = font(27); context.fillText(normal, left + width * 0.72, y, width * 0.28); }
      y += 44;
    }
    y += 24;
  }
  context.fillStyle = MUTED; context.font = font(26);
  let footerY = PAGE.height - MARGIN - (content.footer.length - 1) * 36;
  for (const line of content.footer) { context.fillText(line, MARGIN, footerY, PAGE.width - 2 * MARGIN); footerY += 36; }
  return canvas;
}

export function pngBytes(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob.arrayBuffer()) : reject(new Error('PNG')), 'image/png'));
}
