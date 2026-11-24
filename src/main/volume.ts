import { execFile } from 'node:child_process';
import type { VolumeState } from '../shared/ipc.js';

/**
 * Âm lượng hệ thống của panel, đọc và ghi qua `wpctl`.
 *
 * Vì sao là `wpctl` chứ không phải `pactl`/`pamixer`: panel đo được chỉ cài WirePlumber/PipeWire và
 * chỉ có `wpctl` trong PATH. Gọi `pactl` ở đây sẽ là lệnh chết trên chính máy đích — mọi lần kéo
 * âm lượng đều thất bại mà không ai thấy, vì lỗi của một tiến trình con không tự nổi lên UI.
 *
 * Vì sao đọc lại sau mỗi lần ghi: `wpctl` làm tròn xuống bước 0.01 và có thể từ chối khi sink đang
 * đổi (HDMI cắm lại). Trả về giá trị *thật* sau khi ghi là cách duy nhất để thanh trượt trên UI
 * không hiển thị một con số mà phần cứng chưa hề nhận.
 */

const SINK_TARGET = '@DEFAULT_AUDIO_SINK@';

/** Giới hạn thời gian một lệnh `wpctl` được phép chạy: treo ở đây là treo luôn IPC handler. */
const WPCTL_TIMEOUT_MS = 3000;

interface RawVolume {
  level: number;
  muted: boolean;
}

/**
 * Chạy `wpctl` và trả stdout. Không dùng shell: tham số là hằng số nên `execFile` vừa đủ, và nó
 * tránh mọi chuyện quoting trên một panel không có bàn phím để gõ lại lệnh sai.
 */
function runWpctl(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('wpctl', args, { timeout: WPCTL_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr.trim() || error.message} (wpctl ${args.join(' ')})`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** `Volume: 0.80` hoặc `Volume: 0.80 [MUTED]` — cả hai dạng đều đã đo trên panel. */
function parseGetVolume(stdout: string): RawVolume | null {
  const match = /Volume:\s*([0-9]*\.?[0-9]+)/.exec(stdout);
  if (!match?.[1]) return null;
  const level = Number(match[1]);
  if (!Number.isFinite(level)) return null;
  return { level, muted: stdout.includes('[MUTED]') };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Tên sink đang là mặc định (`node.name`), chỉ dùng để báo lên UI và để log.
 * Đọc lười và nhớ lại: `wpctl inspect` là lệnh nặng nhất trong ba lệnh ở đây, còn tên sink chỉ đổi
 * khi cắm/rút HDMI — lúc đó `readVolume` thất bại và ta xoá cache để lần sau đọc lại.
 */
let sinkName = '';

async function resolveSinkName(): Promise<string> {
  if (sinkName) return sinkName;
  try {
    const stdout = await runWpctl(['inspect', SINK_TARGET]);
    const match = /node\.name\s*=\s*"([^"]+)"/.exec(stdout);
    if (match?.[1]) sinkName = match[1];
  } catch (error) {
    // Không có tên sink không phải lỗi chí mạng: âm lượng vẫn đọc/ghi được qua @DEFAULT_AUDIO_SINK@.
    console.error('[volume] không đọc được tên sink:', (error as Error).message);
  }
  return sinkName;
}

/** Trạng thái rỗng dùng khi không đọc được: UI hiện 0 và không mute thay vì ném lỗi vào IPC. */
async function fallbackState(message: string): Promise<VolumeState> {
  console.error('[volume]', message);
  sinkName = '';
  return { level: 0, muted: false, sink: '' };
}

export async function readVolume(): Promise<VolumeState> {
  try {
    const stdout = await runWpctl(['get-volume', SINK_TARGET]);
    const parsed = parseGetVolume(stdout);
    if (!parsed) return fallbackState(`không hiểu output wpctl: ${stdout.trim().slice(0, 120)}`);
    return { level: clamp01(parsed.level), muted: parsed.muted, sink: await resolveSinkName() };
  } catch (error) {
    return fallbackState(`không đọc được âm lượng: ${(error as Error).message}`);
  }
}

/**
 * Đặt mức âm lượng.
 *
 * Tự bỏ mute khi mức > 0 là chủ ý, không phải tiện tay: trên panel không có nút mute nào khác, nên
 * nếu âm lượng đang bị mute mà người dùng kéo thanh trượt lên, không bỏ mute thì thanh trượt chạy
 * mà máy vẫn câm — và không có đường nào để thoát khỏi trạng thái đó ngoài SSH.
 */
export async function writeVolume(level: number): Promise<VolumeState> {
  const target = clamp01(Number.isFinite(level) ? level : 0);
  try {
    const current = await readVolume();
    if (target > 0 && current.muted) await runWpctl(['set-mute', SINK_TARGET, '0']);
    await runWpctl(['set-volume', SINK_TARGET, target.toFixed(2)]);
    return await readVolume();
  } catch (error) {
    return fallbackState(`không đặt được âm lượng ${target}: ${(error as Error).message}`);
  }
}

export async function writeMuted(muted: boolean): Promise<VolumeState> {
  try {
    await runWpctl(['set-mute', SINK_TARGET, muted ? '1' : '0']);
    return await readVolume();
  } catch (error) {
    return fallbackState(`không đặt được mute=${muted}: ${(error as Error).message}`);
  }
}
