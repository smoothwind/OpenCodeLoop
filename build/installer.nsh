; build/installer.nsh — NSIS 自定义安装脚本（electron-builder 自动引入）
;
; electron-builder 的安装是"覆盖式"的：旧版本里存在、新版本已裁掉的文件不会自动删除。
; 这里在文件释放完成后清理 0.1.3 起不再分发的 Electron 组件，避免升级后磁盘上仍残留
; 旧语言包（约 47 MB）与 WebGPU 着色器编译器（约 26 MB）。
;
; 只删除 Electron 运行时文件，不会触碰 data/ 下的便携配置与用户日志。
;
; ⚠ 版本门控：仅当已安装的旧版本 < 0.1.3 时才执行清理。本宏会随之后每个版本发布，
;   若未来重新引入这些文件（恢复 WebGPU / 增加语言包），无门控会把新装好的文件删掉。
;   重新引入文件时必须同步删除或调整本段。

!include "LogicLib.nsh"
; ${VersionCompare} 定义在 WordFunc.nsh（TextFunc.nsh 中没有该宏）
!include "WordFunc.nsh"

; 卸载器编译（BUILD_UNINSTALLER）不展开 customInstall，变量会因“声明未使用”触发
; NSIS 警告 6001，而 electron-builder 把警告视为错误
!ifndef BUILD_UNINSTALLER
Var OCL_OLD_VERSION
!endif

!macro customInstall
  ; 已安装版本：electron-builder 写在与卸载信息相同的键（SHELL_CONTEXT = HKCU/HKLM 视安装层级）
  ReadRegStr $OCL_OLD_VERSION SHCTX "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"

  ${If} $OCL_OLD_VERSION != ""
    ; VersionCompare 输出：0 = 相等, 1 = 旧版本更新, 2 = 旧版本更旧
    ${VersionCompare} $OCL_OLD_VERSION "0.1.3" $0
    ${If} $0 == 2
      ; 0.1.3 起移除了仅 WebGPU/DX12 使用的 DXIL 编译器
      Delete "$INSTDIR\dxcompiler.dll"
      Delete "$INSTDIR\dxil.dll"

      ; 0.1.3 起只保留中英文语言包（Push/Pop 保存寄存器，避免与外层宏冲突）
      Push $0
      Push $1
      FindFirst $0 $1 "$INSTDIR\locales\*.pak"
      ${DoWhile} $1 != ""
        ${If} $1 != "en-US.pak"
        ${AndIf} $1 != "zh-CN.pak"
          Delete "$INSTDIR\locales\$1"
        ${EndIf}
        FindNext $0 $1
      ${Loop}
      FindClose $0
      Pop $1
      Pop $0
    ${EndIf}
  ${EndIf}
!macroend
