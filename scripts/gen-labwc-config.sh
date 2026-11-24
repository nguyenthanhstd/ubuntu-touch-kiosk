#!/usr/bin/env bash
# gen-labwc-config.sh — write the labwc configuration the kiosk runs under.
#
# WHY THIS EXISTS: labwc is a *stacking* compositor, so unlike Cage it can hold more than one
# window. That is the only way an external app (FreeTube, Firefox, Chromium) can be shown inside the
# same frame as the bar and the dock instead of covering the whole panel.
#
# The geometry is derived, never hard-coded: the bar and the dock are Electron views painted by the
# kiosk, so labwc has no idea they exist. External windows are therefore pinned to the band between
# them by a window rule, which is what makes "an app can never cover the bar or the dock" true by
# construction instead of by hoping each app behaves.
#
# Called by run-kiosk.sh before the compositor starts. Safe to run by hand; it only writes files.
set -uo pipefail

# Must stay equal to FRAME_INSET / TOP_BAR_CSS / DOCK_CSS in src/shared/chrome.ts, and to the
# arithmetic in layoutFor() (src/main/layout.ts). A shell script cannot import TypeScript, so the
# numbers are repeated here exactly as shell.css and layout.ts express them.
TOP_BAR_CSS=44
DOCK_CSS=96
FRAME_INSET=10
# Frame parts, mirrored from framePartsFor() in src/main/layout.ts.
FRAME_RING=2
APP_CLOSE_W=46
APP_CLOSE_H=44

OUTPUT="${NTF_OUTPUT:-HDMI-A-1}"
CONFIG_DIR="${NTF_LABWC_DIR:-$HOME/.config/labwc}"

# The kiosk window title, from `title: 'NT Fitness Touch'` in main.ts.
KIOSK_TITLE="${NTF_KIOSK_TITLE:-NT Fitness Touch}"

warn() { echo "[labwc-config] $*" >&2; }

# The preferred mode of the connected output is the mode wlroots picks at startup. Reading sysfs
# keeps this honest on a panel that is not 2560x1600; the env override exists for a first boot where
# the connector name differs.
detect_size() {
  local file mode
  for file in /sys/class/drm/card*-"$OUTPUT"/modes; do
    [ -r "$file" ] || continue
    mode=$(head -n 1 "$file" 2>/dev/null)
    case "$mode" in
      [0-9]*x[0-9]*)
        WIDTH=${mode%x*}
        HEIGHT=${mode#*x}
        return 0
        ;;
    esac
  done
  return 1
}

WIDTH="${NTF_OUTPUT_W:-}"
HEIGHT="${NTF_OUTPUT_H:-}"
if [ -z "$WIDTH" ] || [ -z "$HEIGHT" ]; then
  if ! detect_size; then
    WIDTH=2560
    HEIGHT=1600
    warn "không đọc được mode của $OUTPUT, dùng 2560x1600"
  fi
fi

case "${WIDTH}${HEIGHT}" in
  *[!0-9]* | '') warn "kích thước không hợp lệ: ${WIDTH}x${HEIGHT}"; exit 1 ;;
esac

DOCK_H=$((HEIGHT * 14 / 100))
[ "$DOCK_H" -gt "$DOCK_CSS" ] && DOCK_H=$DOCK_CSS
CONTENT_TOP=$((FRAME_INSET + TOP_BAR_CSS))
BAND_H=$((HEIGHT - FRAME_INSET - DOCK_H - CONTENT_TOP))
if [ "$BAND_H" -lt 240 ]; then
  warn "băng nội dung quá thấp (${BAND_H}px) — output ${WIDTH}x${HEIGHT} không hợp lệ"
  exit 1
fi
BAND_W=$((WIDTH - FRAME_INSET * 2))
# Mirrors framePartsFor() in src/main/layout.ts: the strips sit *inside* the content rect's edges,
# and the close button is flush with the right edge.
BAND_RIGHT=$((FRAME_INSET + BAND_W - FRAME_RING))
BAND_BOTTOM=$((CONTENT_TOP + BAND_H - FRAME_RING))
CLOSE_X=$((FRAME_INSET + BAND_W - APP_CLOSE_W))
# The corner masks, mirroring FRAME_MASK_CSS / BAND_RADIUS_CSS / FRAME_RING_CSS in
# src/shared/chrome.ts. Each mask is a square window of BAND_RADIUS + FRAME_RING (24 + 2 = 26), so the
# arc of radius 24 is inside it with the 2 px stroke's outer edge exactly on the window's own edge.
# Their origins are the band's four corners: the two on the right and the two at the bottom are pulled
# back by MASK, i.e. the mask's right edge lands on the band's right edge.
BAND_RADIUS=24
MASK=$((BAND_RADIUS + FRAME_RING))
MASK_R=$((FRAME_INSET + BAND_W - MASK))
MASK_B=$((CONTENT_TOP + BAND_H - MASK))

# Ba thẻ nổi (Cài đặt, Âm lượng, Nguồn). Kích thước **phải** khớp PANEL_SPECS trong
# src/main/panel-window.ts — đó là nguồn sự thật cho Electron, còn đây là bản sao duy nhất mà labwc
# đọc được, vì labwc không đọc được TypeScript. Lệch nhau thì cửa sổ được cấp một kích thước và bị
# ResizeTo ép sang kích thước khác, và vì các thẻ này `resizable:false` nên Electron không sửa lại
# được: nội dung sẽ bị cắt chứ không phải co giãn.
PANEL_SETTINGS_W=1020
PANEL_SETTINGS_H=800
PANEL_VOLUME_W=760
PANEL_VOLUME_H=430
PANEL_ZOOM_W=760
PANEL_ZOOM_H=470
PANEL_POWER_W=880
PANEL_POWER_H=620

# Thẻ Cài đặt và Nguồn đặt giữa màn hình. Thẻ Âm lượng và Cỡ chữ treo ngay dưới thanh trên thay vì
# giữa màn hình: cả hai là bảng điều khiển của một nút trên thanh trên, nên phải mọc ra từ thanh trên —
# đặt giữa màn hình thì mắt phải nhảy hai lần. Dưới thanh trên 16 px để bóng đổ của thẻ không dính vào
# viền thanh.
PANEL_SETTINGS_X=$(((WIDTH - PANEL_SETTINGS_W) / 2))
PANEL_SETTINGS_Y=$(((HEIGHT - PANEL_SETTINGS_H) / 2))
PANEL_VOLUME_X=$(((WIDTH - PANEL_VOLUME_W) / 2))
PANEL_VOLUME_Y=$((CONTENT_TOP + 16))
PANEL_ZOOM_X=$(((WIDTH - PANEL_ZOOM_W) / 2))
PANEL_ZOOM_Y=$((CONTENT_TOP + 16))
PANEL_POWER_X=$(((WIDTH - PANEL_POWER_W) / 2))
PANEL_POWER_Y=$(((HEIGHT - PANEL_POWER_H) / 2))

# Where the on-screen keyboard's *overlay* window is placed when it serves an external app.
#
# This file exists because of a measured law of Wayland, not a preference: xdg_toplevel has no
# position request, so Electron's setBounds() cannot move that window at all. Measured on this panel
# three ways — with the rule present the window ignores the drag; with fixedPosition removed it still
# ignores it; with the rule's MoveTo stripped entirely it lands at the compositor's own default
# placement, 402x1104 centred at x=728..1831, never where Electron asked. The window rule is the
# *only* thing that decides, and labwc applies it from its in-memory config at map time only.
#
# So the flow is: Electron writes four integers here (x y w h), re-runs this script, runs
# `labwc --reconfigure` and hides/shows the window. The next map lands on the new numbers. Keeping the
# position in one small file rather than editing rc.xml means the XML stays generated in one place.
#
# Four numbers, not two: y has to be clamped against the popup's *real* height, which the grip moves
# between 200 and 470 px. Storing only x/y would clamp a tall popup against the default height and
# silently drag it back up. The height reaches the compositor only through this file — Electron's
# setBounds sizes the window but cannot re-map it, and for its part labwc's ResizeTo is inert here
# (measured: asked 900x420, got 1119x400 = exactly what Electron had set).
KEYBOARD_POS="${CONFIG_DIR}/ntf-keyboard.pos"
KB_W=$((BAND_W * 55 / 100))
[ "$KB_W" -gt 1100 ] && KB_W=1100
[ "$KB_W" -lt 320 ] && KB_W=320
# Fallback height only: Electron overwrites both numbers before the popup is ever shown. Mirrors
# KEYBOARD_DEFAULT_H in src/shared/chrome.ts for the first boot, before a settings file exists.
KB_H="${NTF_KEYBOARD_H:-260}"
KB_X=$((FRAME_INSET + BAND_W - KB_W))
KB_Y=$((CONTENT_TOP + BAND_H - KB_H - 12))
if [ -r "$KEYBOARD_POS" ]; then
  kb_x='' kb_y='' kb_w='' kb_h=''
  read -r kb_x kb_y kb_w kb_h 2>/dev/null <"$KEYBOARD_POS" || true
  # All four must be present and integral: a short or hand-edited file must be ignored whole, not
  # half-applied, or KB_W/KB_H end up empty and the arithmetic below fails.
  case "${kb_x}:${kb_y}:${kb_w}:${kb_h}" in
    *[!0-9:-]*) warn "bỏ qua $KEYBOARD_POS (cần bốn số nguyên)" ;;
    *::* | :* | *:) warn "bỏ qua $KEYBOARD_POS (cần bốn số nguyên)" ;;
    *)
      # The size comes from the main process too: it is the popup's real clamped height, which the
      # grip can move between 200 and 470 px. Clamping y against a hard-coded default height would
      # silently drag a tall popup back up and undo the visitor's resize.
      KB_X=$kb_x
      KB_Y=$kb_y
      KB_W=$kb_w
      KB_H=$kb_h
      ;;
  esac
fi
# Re-clamped against *this* panel: a stored rectangle from another mode (or a hand-edited file) must
# never park the popup under the bar or off the edge, where it could neither be read nor dragged back.
[ "$KB_W" -gt "$BAND_W" ] && KB_W=$BAND_W
[ "$KB_H" -gt "$BAND_H" ] && KB_H=$BAND_H
[ "$KB_X" -lt "$FRAME_INSET" ] && KB_X=$FRAME_INSET
[ "$KB_X" -gt $((FRAME_INSET + BAND_W - KB_W)) ] && KB_X=$((FRAME_INSET + BAND_W - KB_W))
[ "$KB_Y" -lt "$CONTENT_TOP" ] && KB_Y=$CONTENT_TOP
[ "$KB_Y" -gt $((CONTENT_TOP + BAND_H - KB_H)) ] && KB_Y=$((CONTENT_TOP + BAND_H - KB_H))

mkdir -p "$CONFIG_DIR" || exit 1

{
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED by scripts/gen-labwc-config.sh — do not edit; edit the script instead.
     Output ${OUTPUT} ${WIDTH}x${HEIGHT}. External windows are pinned to
     x=${FRAME_INSET} y=${CONTENT_TOP} ${BAND_W}x${BAND_H}: the band between the bar and the dock,
     both of which the kiosk itself paints. -->
<labwc_config>

  <core>
    <!-- Server-side decoration as the compositor-wide default, then every window rule below sets
         serverDecoration="no" to push decoration back to the client. That combination is what
         measured exact, and the reason is arithmetic: ResizeTo sizes the surface, so whatever
         draws the titlebar must draw it *inside* that surface. Left undecided, each app brought a
         headerbar of its own height — 26 px for FreeTube (libdecor), 31 px for Chromium — added on
         top of the size ResizeTo had already applied, which is why the window overflowed the band
         and covered the top of the dock. Nothing here removes a titlebar by action; the attribute
         is what decides, and an action is what breaks it (see the rules below). -->
    <decoration>server</decoration>
    <gap>0</gap>
    <adaptiveSync>no</adaptiveSync>
    <allowTearing>yes</allowTearing>
    <xwaylandPersistence>no</xwaylandPersistence>
  </core>

  <placement>
    <policy>center</policy>
  </placement>

  <theme>
    <cornerRadius>0</cornerRadius>
    <keepBorder>no</keepBorder>
    <dropShadows>no</dropShadows>
    <dropShadowsOnTiled>no</dropShadowsOnTiled>
    <!-- Belt and braces. maximised windows get their titlebar from this key, not from
         <core><decoration>, so leaving it at its "titlebar" default would re-add the 27 px
         even on a window whose decoration was already stripped. -->
    <maximizedDecoration>none</maximizedDecoration>
  </theme>

  <!-- No <keyboard> block on purpose: that keeps labwc's default Alt+Tab / Alt+F4 / Super binds
       off. A visitor at the panel must not be able to cycle or close windows with a stray chord,
       and there is no keyboard attached to the intended audience anyway. -->

  <!-- ORDER IS LOAD-BEARING. labwc applies the actions of every matching rule in file order, so the
       kiosk rule below runs last and therefore wins the geometry back from the catch-all. If these
       two are ever swapped, the kiosk ends up confined to the band and the panel shows black bars.
       The frame rules come after the catch-all for the same reason, and last of all comes the kiosk
       so nothing can shrink it. Properties resolve the other way — last match wins — so a frame
       window that ever fell into type="normal" would still take its decoration settings from here.
       Every rule carries at most one toggle action, because a window matching two rules that each
       toggle always-on-bottom would end up visible-on-top instead. -->
  <windowRules>
    <!-- Anything the dock can launch — FreeTube, Firefox, Chromium, and whatever is installed later
         — is resized into the band and pinned there. type="normal" keeps dialogs, menus and
         tooltips out of this rule so they still place themselves the way they expect to. -->
    <!-- serverDecoration="no" ALONE is what makes the geometry exact. Left at "default", a client
         is free to bring its own titlebar, and then ResizeTo reports the client area while the
         visible window is that area plus the titlebar: Chromium measured bottom y=1519 and FreeTube
         1466 px tall, both past the 1493 the band ends at. Forcing client-side decoration makes any
         titlebar the app draws live *inside* the surface ResizeTo sized, so those numbers are the
         visible size by construction. This attribute is applied after the actions below, which is
         why "yes" was wrong here: it put a fresh server titlebar back on top of what had just been
         removed. Do NOT add ToggleDecorations — it is 3-state, and invoking it on an
         already-undecorated window ADDS a 27 px titlebar rather than removing one; that mistake
         pushed the kiosk view down and cropped the dock. -->
    <windowRule identifier="*" type="normal" serverDecoration="no">
      <!-- UnMaximize is not decorative: Firefox is a snap that re-maximises itself after map, which
           makes labwc size it to the whole output and ignore ResizeTo entirely — measured maximised
           it covered x 0-2559 and reached y=1545, over both gutters and 52 px into the dock.
           UnMaximize on a window that was never maximised is a no-op, so it is safe for every
           other app. Order matters: it must come before ResizeTo/MoveTo. -->
      <action name="UnMaximize" />
      <action name="ResizeTo" width="${BAND_W}" height="${BAND_H}" />
      <action name="MoveTo" x="${FRAME_INSET}" y="${CONTENT_TOP}" />
    </windowRule>

    <!-- The nine frame windows of src/main/frame-window.ts: four 2 px strips, four 26x26 corner
         masks, and the 46x44 close button that sits over the external app's own ✕.

         These rules sit AFTER the catch-all deliberately. labwc runs the actions of every matching
         rule in file order and the last result wins, so a frame rule placed before the catch-all
         would have its MoveTo undone for free. Down here the frame geometry is the last word even
         if the structural exemption below ever stops holding.

         The exemption itself: Electron's resizable:false calls SetSizeConstraints(size, size), which
         reaches the compositor as min == max on the xdg_toplevel, and labwc types exactly that
         (min and max both set and equal, no parent) as type="dialog" while the catch-all is
         type="normal". Verified in labwc 0.9.3 src/xdg.c:xdg_toplevel_view_contains_window_type().
         That is also why main.ts passes the rects to the BrowserWindow *constructor*: a window
         created at Electron's default size and resized afterwards would advertise min == max of
         the wrong size.

         ResizeTo is repeated in each rule for the same reason: it is one extra call and it makes
         the size hold whether or not the typing above does.

         Under Wayland a client cannot place its own toplevel — the compositor decides, and
         <placement><policy>center</policy> would stack all nine in the middle of the panel. MoveTo is
         therefore the only thing that puts them where the frame goes; the kiosk's own 0,0 comes from
         exactly this mechanism. fixedPosition is a property, and it stops labwc re-centring a float
         afterwards (view.c:adjust_floating_geometry returns early on it).

         ToggleAlwaysOnTop IS required here, and the history matters because the obvious reading is
         wrong. An external app is resized to exactly x=FRAME_INSET y=CONTENT_TOP BAND_WxBAND_H, so
         its surface is *coincident* with these strips: same pixels, different windows. Whether the
         ring is visible is therefore decided purely by stacking order, and Electron cannot supply
         it — on Wayland there is no raise request, so setAlwaysOnTop and moveTop() in
         frame-window.ts are both silent no-ops. Measured in that state the ring disappeared the
         moment an app mapped, and reappeared only when the app did not overlap a strip.

         labwc has no AlwaysOnTop *attribute*; the action is the only lever. It is safe to fire from
         a map-time rule because labwc runs window rules once, when the view maps, so each frame
         surface is promoted exactly once and cannot toggle itself back down. It must NOT be
         ToggleAlwaysOnBottom: that would put the frame in the same layer as the kiosk and the app
         would cover it again.

         Verified after this change with pixels: left x10=(255,255,255) x11=(127,127,127), right
         x2548=(120,120,120) x2549=(252,252,252), bottom y1492=(127,127,127) y1493=(255,255,255),
         with FreeTube mapped and focused. -->
    <windowRule title="NTF frame top" fixedPosition="yes" skipTaskbar="yes"
               skipWindowSwitcher="yes" serverDecoration="no">
      <action name="ResizeTo" width="${BAND_W}" height="${FRAME_RING}" />
      <action name="MoveTo" x="${FRAME_INSET}" y="${CONTENT_TOP}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <windowRule title="NTF frame bottom" fixedPosition="yes" skipTaskbar="yes"
               skipWindowSwitcher="yes" serverDecoration="no">
      <action name="ResizeTo" width="${BAND_W}" height="${FRAME_RING}" />
      <action name="MoveTo" x="${FRAME_INSET}" y="${BAND_BOTTOM}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <windowRule title="NTF frame left" fixedPosition="yes" skipTaskbar="yes"
               skipWindowSwitcher="yes" serverDecoration="no">
      <action name="ResizeTo" width="${FRAME_RING}" height="${BAND_H}" />
      <action name="MoveTo" x="${FRAME_INSET}" y="${CONTENT_TOP}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <windowRule title="NTF frame right" fixedPosition="yes" skipTaskbar="yes"
               skipWindowSwitcher="yes" serverDecoration="no">
      <action name="ResizeTo" width="${FRAME_RING}" height="${BAND_H}" />
      <action name="MoveTo" x="${BAND_RIGHT}" y="${CONTENT_TOP}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <!-- The close button is the only one of the nine that takes input, so it also must not be
         focused: a focused close window would pull the caret out of whatever the visitor is typing
         into behind it. That is set on the Electron side (focusable:false); nothing labwc could do
         about focus here would be more precise. -->
    <windowRule title="NTF frame close" fixedPosition="yes" skipTaskbar="yes"
               skipWindowSwitcher="yes" serverDecoration="no">
      <action name="ResizeTo" width="${APP_CLOSE_W}" height="${APP_CLOSE_H}" />
      <action name="MoveTo" x="${CLOSE_X}" y="${CONTENT_TOP}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>
    <!-- The four corner masks. Same shape of rule as the strips, but 26x26 instead of a 2 px line,
         and they are the reason an external app's square corner stops showing.

         Why a window is needed at all: the band is a rectangle, every app fills it with a
         *rectangular* surface, and labwc is a stacking compositor — no Wayland protocol lets one
         surface clip another, and labwc's cornerRadius only rounds buffers the compositor itself
         draws (decorations and shadows), which serverDecoration="no" above means it never does. So
         inside the 24 px arc the app's own pixels reach the square corner, and the ring's arcs only
         cover the last rows next to the tangents. The diagonal wedge is what reads as "the corner
         pokes out".

         The fix is a square of the *wallpaper* over the wedge: frame.js paints the same wallpaper the
         nav page painted underneath, offset by these coordinates, and clip-path/mask-image cuts the
         card's quarter-disc out of it. Matching pixels are invisible; app pixels are replaced.

         These four come BEFORE the strip rules for a reason that is visible only at 1x zoom: the
         mask's opaque area overlaps the strips' first two rows exactly at the corner, where the arc
         is squashed into the 2 px band. labwc stacks in rule order here, and Electron stacks in
         PART_ORDER order, and both lists put the masks first so the ring is painted last. Swapping
         either one makes the corner look clipped instead of rounded. -->
    <windowRule title="NTF frame corner-tl" fixedPosition="yes" skipTaskbar="yes"
               skipWindowSwitcher="yes" serverDecoration="no">
      <action name="ResizeTo" width="${MASK}" height="${MASK}" />
      <action name="MoveTo" x="${FRAME_INSET}" y="${CONTENT_TOP}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <windowRule title="NTF frame corner-tr" fixedPosition="yes" skipTaskbar="yes"
               skipWindowSwitcher="yes" serverDecoration="no">
      <action name="ResizeTo" width="${MASK}" height="${MASK}" />
      <action name="MoveTo" x="${MASK_R}" y="${CONTENT_TOP}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <windowRule title="NTF frame corner-bl" fixedPosition="yes" skipTaskbar="yes"
               skipWindowSwitcher="yes" serverDecoration="no">
      <action name="ResizeTo" width="${MASK}" height="${MASK}" />
      <action name="MoveTo" x="${FRAME_INSET}" y="${MASK_B}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <windowRule title="NTF frame corner-br" fixedPosition="yes" skipTaskbar="yes"
               skipWindowSwitcher="yes" serverDecoration="no">
      <action name="ResizeTo" width="${MASK}" height="${MASK}" />
      <action name="MoveTo" x="${MASK_R}" y="${MASK_B}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <!-- The on-screen keyboard when it serves an *external* app (Firefox, FreeTube, Chromium).

         Why a window and not a view: the keyboard is normally a WebContentsView inside the kiosk,
         and the kiosk is pinned ToggleAlwaysOnBottom by the rule below. A view never escapes the
         layer of its own toplevel, so as soon as Firefox or FreeTube is in front the popup is
         completely covered — measured in report 07 (R05 FAIL). Only a separate toplevel can be
         stacked above an ordinary client, which is exactly the trick the nine "NTF frame" windows
         above already use, so this copies them rather than inventing an overlay.

         ToggleAlwaysOnTop is what puts it above the app, NOT the bottom layer: the popup has to
         float over Firefox. It is fixedPosition so the compositor — which is the only party that may
         position a Wayland toplevel — pins it to MoveTo and never re-tiles it.

         MoveTo is not an optimisation here, it is the ONLY way this window can be placed. Measured
         three ways on this panel: xdg_toplevel has no position request, so Electron's setBounds() is
         a no-op for this window; with fixedPosition removed the window still ignores it; and with
         MoveTo stripped entirely the window lands at labwc's own default placement (402x1104, centred
         at x=728..1831) rather than where Electron asked. The numbers below come from ntf-keyboard.pos
         written by the main process, and labwc only reads them at map time — so a move is committed by
         writing the file, re-running this script, `labwc --reconfigure` and re-mapping the window.
         Re-map is safe: measured over three consecutive hide/show cycles, ToggleAlwaysOnTop does not
         re-fire and the window lands on the same rectangle every time.

         ResizeTo is deliberately ABSENT: it is inert for this window. Measured by putting
         ResizeTo 900x420 in this very rule while Electron had set 1100x389 — the window came up
         1119x400, i.e. Electron's size, not the rule's. Sizing belongs to setBounds (toplevel
         set_size exists); only position needs the compositor. Adding ResizeTo here would be dead code.

         Matched on title alone, and Electron freezes the title (page-title-updated is cancelled in
         keyboard-overlay.ts) so this rule cannot stop matching mid-session. -->
    <windowRule title="NTF keyboard" fixedPosition="yes" skipTaskbar="yes"
               skipWindowSwitcher="yes" serverDecoration="no">
      <action name="MoveTo" x="${KB_X}" y="${KB_Y}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <!-- The screen saver. It is its own toplevel (see main/lock-overlay.ts) because every
         WebContentsView the kiosk owns is pinned below every external app, so a view-based overlay
         would leak whatever Firefox or FreeTube is playing. This rule is what actually puts it on
         top; a screen-saver layer hint alone is not enough on labwc 0.9.3.

         ToggleAlwaysOnTop rather than a layer attribute: it is the same action the keyboard rule
         above uses and the only one measured to work here.

         ResizeTo IS present, unlike the keyboard rule: the lock window is resizable:false, so labwc
         types it as a dialog and it never matches the type="normal" catch-all that sizes everything
         else. Without this the overlay would be whatever Electron asked for — which happens to be
         the panel size today, but a leftover geometry hint from the compositor would leave a strip
         of the desk showing under a locked panel.

         MUST stay above the kiosk rule: matching rules are applied in document order, and the kiosk
         rule's ToggleAlwaysOnBottom would otherwise be the last word on the layer stack. -->
    <windowRule title="NTF lock" fixedPosition="yes" skipTaskbar="yes" skipWindowSwitcher="yes"
               serverDecoration="no">
      <action name="ResizeTo" width="${WIDTH}" height="${HEIGHT}" />
      <action name="MoveTo" x="0" y="0" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <!-- The three floating panels: settings, volume, power.

         Every one of them needs ResizeTo even though Electron already sized the window. The cause is
         resizable:false in panel-window.ts: labwc derives the window *type* from the resize hints, so
         a non-resizable window becomes type="dialog" and misses the type="normal" catch-all above,
         arriving with whatever geometry the hint asked for. ResizeTo is what actually pins it, and it
         is also why these rules cannot be merged into the catch-all.

         MoveTo is mandatory, not cosmetic: xdg_toplevel has no position request, so setBounds() in
         Electron sizes a window but cannot move it. Rule order decides the layer, and these four must
         come before the kiosk rule below — ToggleAlwaysOnBottom there would otherwise be the last word
         on the stack for anything mapped after it.

         The lock overlay, not the kiosk, is what must end up on top of these; PanelHost.hideAll()
         takes care of the case where a panel is open when the lock fires. -->
    <windowRule title="NTF settings" fixedPosition="yes" skipTaskbar="yes" skipWindowSwitcher="yes"
               serverDecoration="no">
      <action name="ResizeTo" width="${PANEL_SETTINGS_W}" height="${PANEL_SETTINGS_H}" />
      <action name="MoveTo" x="${PANEL_SETTINGS_X}" y="${PANEL_SETTINGS_Y}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <!-- Below the bar, not centred: this panel belongs to the bar's speaker button, so it has to grow
         out of the bar. CONTENT_TOP is the bottom edge of the 44 px bar, and the extra 16 px keeps the
         card's shadow off the bar's own edge instead of smearing it. -->
    <windowRule title="NTF volume" fixedPosition="yes" skipTaskbar="yes" skipWindowSwitcher="yes"
               serverDecoration="no">
      <action name="ResizeTo" width="${PANEL_VOLUME_W}" height="${PANEL_VOLUME_H}" />
      <action name="MoveTo" x="${PANEL_VOLUME_X}" y="${PANEL_VOLUME_Y}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <!-- Cùng chỗ với thẻ Âm lượng và cùng lý do: nó thuộc về nút Cỡ chữ trên thanh trên. Thẻ này có
         bốn nút mức nên cao hơn thẻ Âm lượng 40 px; chiều cao phải khớp PANEL_ZOOM_H ở trên, lệch thì
         ResizeTo ép cửa sổ và vì `resizable:false` Electron không sửa lại được — nội dung bị cắt. -->
    <windowRule title="NTF zoom" fixedPosition="yes" skipTaskbar="yes" skipWindowSwitcher="yes"
               serverDecoration="no">
      <action name="ResizeTo" width="${PANEL_ZOOM_W}" height="${PANEL_ZOOM_H}" />
      <action name="MoveTo" x="${PANEL_ZOOM_X}" y="${PANEL_ZOOM_Y}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <windowRule title="NTF power" fixedPosition="yes" skipTaskbar="yes" skipWindowSwitcher="yes"
               serverDecoration="no">
      <action name="ResizeTo" width="${PANEL_POWER_W}" height="${PANEL_POWER_H}" />
      <action name="MoveTo" x="${PANEL_POWER_X}" y="${PANEL_POWER_Y}" />
      <action name="ToggleAlwaysOnTop" />
    </windowRule>

    <!-- The kiosk owns the wallpaper, the bar and the dock, so it must be exactly the whole panel.
         It is pinned to the bottom layer: otherwise a tap on the bar would raise the kiosk over
         whichever app is open, and because the kiosk paints an opaque wallpaper across the entire
         panel that app would vanish with no taskbar to bring it back. fixedPosition keeps the frame
         from ever being dragged or resized. Matched on title alone — a second rule matching the
         same window would toggle the layer straight back off. -->
    <windowRule title="${KIOSK_TITLE}" fixedPosition="yes" skipTaskbar="yes" skipWindowSwitcher="yes"
               serverDecoration="no">
      <!-- Same recipe as the rule above, and it is NOT redundant: the catch-all is scoped to
           type="normal" and does not match the kiosk. Without serverDecoration="no" the kiosk grew
           a 27 px server titlebar (#e1dedb at y1-26) that pushed the whole Electron view down,
           which moved the bar to y37-80 and cropped the dock off the bottom of the panel.
           ToggleDecorations is deliberately absent: it is 3-state and invoking it on an
           already-undecorated window puts a titlebar back. -->
      <action name="ResizeTo" width="${WIDTH}" height="${HEIGHT}" />
      <action name="MoveTo" x="0" y="0" />
      <action name="ToggleAlwaysOnBottom" />
    </windowRule>
  </windowRules>

</labwc_config>
EOF
} >"$CONFIG_DIR/rc.xml" || exit 1

# An autostart file that does nothing: labwc runs it on every start, and a leftover from a manual
# experiment would launch a second client on top of the kiosk. The kiosk itself is started with
# `labwc -S`, which also tears the compositor down when the kiosk exits.
printf '# Intentionally empty: the kiosk is started by labwc -S, see scripts/run-kiosk.sh\n' \
  >"$CONFIG_DIR/autostart"

# Empty root menu. Without the file labwc still composes, but every right-click on the wallpaper
# logs a missing-menu warning.
cat >"$CONFIG_DIR/menu.xml" <<'MENUEOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu />
MENUEOF

echo "[labwc-config] ${WIDTH}x${HEIGHT} -> band ${BAND_W}x${BAND_H} at ${FRAME_INSET},${CONTENT_TOP}"
echo "[labwc-config] wrote $CONFIG_DIR/rc.xml"