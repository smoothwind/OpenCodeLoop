; build/installer.nsh — NSIS 自定义安装脚本（electron-builder 自动引入）
;
; electron-builder 的安装是"覆盖式"的：旧版本里存在、新版本已裁掉的文件不会自动删除。
; 这里在文件释放完成后清理 0.1.3 起不再分发的 Electron 组件，避免升级后磁盘上仍残留
; 旧语言包（约 47 MB）与 WebGPU 着色器编译器（约 26 MB）。
;
; 只删除 Electron 运行时文件，不会触碰 data/ 下的便携配置与用户日志。

!include "LogicLib.nsh"

!macro customInstall
  ; 0.1.3 起移除了仅 WebGPU/DX12 使用的 DXIL 编译器
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\dxil.dll"

  ; 0.1.3 起只保留中英文语言包
  FindFirst $0 $1 "$INSTDIR\locales\*.pak"
  ${DoWhile} $1 != ""
    ${If} $1 != "en-US.pak"
    ${AndIf} $1 != "zh-CN.pak"
      Delete "$INSTDIR\locales\$1"
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0
!macroend
