export {
  registerCommand,
  unregisterCommand,
  getCommand,
  getAllCommands,
  getAvailableCommands,
  runCommand,
  commandVersion,
} from './command'
export type { Command } from './command'

export {
  normalizeShortcut,
  eventToShortcut,
  findShortcutIssues,
  createShortcutController,
  shortcuts,
  RESERVED_SHORTCUTS,
} from './shortcut'
export type { ShortcutController, ShortcutIssue } from './shortcut'

export { createPreferences } from './preferences'
export type { Preferences, PreferencesOptions } from './preferences'

export { createI18n, provideI18n, useI18n, tryUseI18n } from './i18n'
export type { I18nInstance, I18nOptions, MessageTree } from './i18n'

export { setPlatformAdapter, getPlatformAdapter, createWebWindowControls } from './platform'
export type { PlatformAdapter, WindowControls } from './platform'
