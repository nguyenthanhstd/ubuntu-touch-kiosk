/**
 * Hợp đồng của bốn thẻ nổi: Cài đặt, Âm lượng, Cỡ chữ, Nguồn.
 *
 * Vì sao phải là một tệp riêng thay vì thêm vào `ipc.ts`: bốn thẻ này là bốn cửa sổ độc lập, mỗi cửa
 * sổ chỉ có một cầu nối hẹp. Nhét chúng vào `ipc.ts` sẽ khiến tệp đó vượt trần 300 dòng và khiến người
 * đọc tưởng thanh trên, dock và thẻ nổi dùng chung một bề mặt — chúng không hề dùng chung.
 *
 * Nguyên tắc chung của cả bốn: **không bao giờ trả cấu hình thô ra renderer**, và **không có bí mật
 * nào ở phía ứng dụng**. Mã xác thực cho ba hành động phá huỷ chính là mật khẩu sudo của máy: nó đi
 * một chiều từ bàn phím số vào stdin của `sudo -S -v` (`sudo-check.ts`) rồi biến mất theo tiến trình
 * con. Không có hàm băm, không có tệp, không có gì để lộ.
 */
import type { AdblockStats } from './chrome.js';
import type { VolumeState } from './ipc.js';
import type { ZoomLevel } from './services.js';

/** Phần cấu hình mà thẻ Cài đặt được phép thấy. */
export interface PanelPolicy {
  idleTimeoutMs: number;
  keepAwakeOnMedia: boolean;
}

/** Cầu nối của trang Cài đặt. */
export interface SettingsPanelApi {
  getPolicy(): Promise<PanelPolicy>;
  /**
   * Ghi cả hai giá trị trong **một** lần: mỗi lần ghi là một lần ghi đĩa toàn bộ tệp cấu hình, và
   * hai lần ghi cho một cú chạm Lưu là hai lần hỏng được.
   *
   * Giá trị ngoài danh sách `IDLE_CHOICES_MS` bị main process từ chối và trả lại trạng thái cũ, nên
   * trang không phải tự kiểm — nhưng vẫn phải vẽ lại theo đúng thứ main trả về.
   */
  savePolicy(next: { idleTimeoutMs: number; keepAwakeOnMedia: boolean }): Promise<PanelPolicy>;
  /**
   * Số liệu chặn quảng cáo, đọc từ tệp JSON mà timer root ghi ra. Chỉ đọc — mọi thay đổi bộ lọc
   * vẫn phải làm ở giao diện web AdGuard, vì app không giữ mật khẩu quản trị.
   */
  getAdblock(): Promise<AdblockStats>;
  close(): void;
}

/** Cầu nối của thẻ Âm lượng. Ba kênh, đúng bằng ba việc thẻ này làm được. */
export interface VolumePanelApi {
  getVolume(): Promise<VolumeState>;
  setVolume(level: number): Promise<VolumeState>;
  setMuted(muted: boolean): Promise<VolumeState>;
  close(): void;
}

/**
 * Cầu nối của thẻ Cỡ chữ.
 *
 * Bốn mức rời rạc chứ không phải một số thực: mỗi mức là một `ZoomLevel` mà `ViewManager` đã biết
 * cách dựng lại, và một giá trị lạ từ trang không thể đẩy được view vào một tỉ lệ không ai kiểm.
 */
export interface ZoomPanelApi {
  /** 
ull khi không có trang nào đang hiện — thẻ vẽ mức mặc định và khoá các nút. */
  getZoom(): Promise<ZoomLevel | null>;
  /** Trả về mức **sau khi** áp dụng, để trang vẽ theo sự thật chứ không theo ý định. */
  setZoom(level: ZoomLevel): Promise<ZoomLevel | null>;
  close(): void;
}

/**
 * Kết quả một hành động nguồn.
 *
 * Không dùng `boolean` vì thất bại ở đây luôn có lý do phân biệt được (sai mã, đang bị chặn vì nhập
 * sai quá nhiều, chưa cài quy tắc polkit) và người đứng ở panel cần đọc được lý do đó.
 */
export interface PowerResult {
  ok: boolean;
  message: string;
}

/**
 * Cầu nối của thẻ Nguồn.
 *
 * Ba hành động phá huỷ đều **nhận mã ngay trong lời gọi**, không có bước "mở khoá trước rồi hành
 * động sau". Hai bước rời sẽ tạo ra một khoảng thời gian mà thẻ đã được phép và bất kỳ cú chạm nào
 * cũng hành động — đúng khoảng thời gian ta không muốn tồn tại.
 */
export interface PowerPanelApi {
  /** Màn hình chờ — không hỏi mã, không phá huỷ gì. */
  lock(): void;
  restart(code: string): Promise<PowerResult>;
  shutdown(code: string): Promise<PowerResult>;
  /** Thoát giao diện kiosk ra console Ubuntu, sau khi xác thực mã. */
  exitToConsole(code: string): Promise<PowerResult>;
  close(): void;
}