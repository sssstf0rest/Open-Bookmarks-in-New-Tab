# v2.4.0 — Duplicate tabs, disappearing tabs, and bookmark renaming

This release is almost entirely bug fixes, focused on one family of problems: clicking a
bookmark could open **two** tabs, or make tabs **disappear**. Several long-standing reports
turned out to share a single root cause.

If you use this extension daily, this is the release to update to.

---

## Fixed — duplicate and disappearing tabs

- **Clicking one bookmark opened two identical tabs.** Most visible with *Focus new tab*
  turned **off**, which is why some users saw it constantly and others never did. The setting
  was never the cause — it was only hiding the bug.
- **"Open all bookmarks" left only one tab open**, with the rest vanishing. All the
  bookmarks in the folder were collapsing onto a single tab.
- **Cmd/Ctrl+click and middle-click opened a tab that immediately disappeared.**
- **Internal / LAN addresses** (e.g. `192.168.x.x`, router admin pages) opened two copies.
- **Gmail and Outlook bookmarks opened two tabs.**

## Fixed — bookmarks

- **Renaming a bookmark while saving it no longer gets lost.** Previously, pressing
  Ctrl/Cmd+D and changing the name in the save popup would silently keep the *original*
  name. Renaming afterwards via right-click → Edit worked, which made the bug look random.
- **Gmail / Outlook bookmarks saved by older versions now convert automatically.** Before,
  updating the extension left them in their old, broken form — the only way to fix them was
  to manually pause and re-enable the extension. Bookmarks now migrate on update, in both
  directions, whenever the special-domain list changes.
- **Bookmarks added while the extension was paused are no longer modified.** Adding a
  bookmark shortly after pausing could still rewrite its URL.

## Fixed — reliability

- **The extension could silently stop working after being paused once.** Its on/off setting
  and its redirect rule could drift out of agreement — the extension looked enabled but
  behaved completely differently. They are now checked and reconciled every time the
  extension starts.
- **Real downloads are no longer cancelled by mistake.** In rare cases a genuine file
  download could be claimed and cancelled by the extension.
- **New tabs open in the correct window** in multi-window setups, and respect the chosen
  position more reliably.
- **Rapid consecutive bookmark clicks** no longer confuse the extension's internal state.

## Security

- **The redirect helper page now only follows `http(s)` destinations.** This page is used
  for Gmail/Outlook bookmarks and takes its destination from the URL. A hand-edited or
  synced bookmark could previously point it at a `javascript:` URL, which would run in the
  page's origin. The destination is now validated before it is used or shown as a link.

---

## Behaviour changes worth knowing

- **A newly created bookmark is now activated a few seconds after you finish editing it.**
  This is what makes renaming-while-saving work. During those few seconds the bookmark opens
  in the current tab rather than a new one. This is intentional.
- **Cmd/Ctrl+click and middle-click now keep the new tab in the background**, matching
  Chrome's normal behaviour, instead of following the *Focus new tab* setting.

## Known issues

These are **not** fixed in this release:

- **A bookmark tab that is still loading can be closed if you click another bookmark before
  its page has loaded.** If the tab still shows *Untitled / Loading* with no title or
  favicon, clicking a second bookmark may discard it. Waiting until the page title appears
  avoids it. A fix is in progress.
- **A brief `empty.zip` download may still appear** on some systems. It is a dummy file used
  to stop the current page from navigating, and it is cancelled automatically — but it can
  flash in the download bar before that happens.
- **Media on the current page can still be interrupted** when a bookmark is clicked. Spotify
  Web Player is the most reliable example. This is a Chrome extension platform limitation.
- **Uninstalling while the extension is enabled leaves the `newtab@` prefix in your bookmark
  URLs.** Chrome gives extensions no chance to clean up on uninstall. **Pause the extension
  first**, which restores every bookmark, and then uninstall.

---

## Upgrading

No action needed — just update. Existing bookmarks are migrated automatically the first time
the new version runs.

If you previously worked around the Gmail/Outlook problem by pausing and re-enabling the
extension, you no longer need to.

**Full changelog:** https://github.com/sssstf0rest/Open-Bookmarks-in-New-Tab/compare/v2.3.0...v2.4.0

---
---

# v2.4.0 — 重复标签页、标签页消失、以及书签重命名

本次更新几乎全部为问题修复，集中解决同一类问题：点击书签时可能**打开两个标签页**，或导致**标签页消失**。多个长期存在的反馈最终被确认源自同一个根本原因。

如果您经常使用此扩展，建议更新到此版本。

## 已修复 — 重复与消失的标签页

- **点击一个书签却打开两个相同的标签页。** 在关闭「聚焦新标签页」时最为明显，这也是为什么部分用户频繁遇到而另一些用户从未遇到。该设置本身并非原因，它只是掩盖了问题。
- **「打开全部书签」时只剩一个标签页**，其余全部消失。
- **Cmd/Ctrl+点击或中键点击**打开的标签页会立即消失。
- **内网地址**（如 `192.168.x.x`、路由器管理页）会打开两个副本。
- **Gmail 与 Outlook 书签**会打开两个标签页。

## 已修复 — 书签

- **保存书签时修改名称不再丢失。** 此前按 Ctrl/Cmd+D 并在弹窗中修改名称后，书签仍会保留*原始*名称；而事后右键→修改却能成功，这使得该问题看起来时有时无。
- **旧版本保存的 Gmail / Outlook 书签现在会自动转换。** 此前更新扩展并不会修复它们，唯一的办法是手动暂停再重新启用。
- **扩展暂停期间新增的书签不再被修改。**

## 已修复 — 稳定性

- **扩展在暂停过一次后可能悄然失效。** 开关状态与重定向规则可能不一致，导致扩展看似已启用、实际行为却完全不同。现在每次启动都会自动校正。
- **不再误取消真实的文件下载。**
- **多窗口下新标签页会在正确的窗口中打开。**
- **连续快速点击书签**不再导致内部状态混乱。

## 安全性

- **重定向辅助页现在仅接受 `http(s)` 目标地址。** 该页面用于 Gmail/Outlook 书签，其目标来自 URL 参数。此前经手动编辑或同步的书签可能指向 `javascript:` 地址并被执行。

## 行为变化

- **新建书签会在您编辑完成几秒后才生效**，这正是重命名得以保留的原因。在这几秒内点击该书签会在当前标签页打开，属于预期行为。
- **Cmd/Ctrl+点击与中键点击现在保持新标签页在后台**，与 Chrome 的默认行为一致。

## 已知问题（本次未修复）

- **正在加载中的书签标签页，若在其加载完成前点击另一个书签，可能会被关闭。** 若标签页仍显示「无标题 / 正在加载」，请等待标题出现后再点击其他书签。修复正在进行中。
- **部分系统上仍可能短暂出现 `empty.zip` 下载提示。** 这是用于阻止当前页面跳转的虚拟文件，会被自动取消。
- **点击书签时当前页面的媒体播放仍可能被打断**（Spotify 网页版最为明显），这是 Chrome 扩展平台的限制。
- **在扩展启用状态下卸载，书签 URL 中会残留 `newtab@` 前缀。** 请先在扩展弹窗中**暂停**（会自动还原所有书签）再卸载。

## 升级说明

无需任何操作，直接更新即可。首次运行新版本时会自动迁移现有书签。
