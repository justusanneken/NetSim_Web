export { CliSession, CliError } from './session';
export { Registry, K, P, R, choice, opt, tokenize } from './parser';
export type { CommandDef, ModeId, Slot, Env } from './parser';
export type { Shell } from './shell';
export { renderRunningConfig, isCliDevice } from './render';
export { secretHash, type7Encrypt, type7Decrypt } from './secrets';
export { ciscoMac, winMac, shortName, resolvePort } from './format';
export { HostShell } from './hostshell';
export { Terminal } from './terminal';
export { waitFor } from './util';
export { ShellStack } from './shellstack';
export type { ShellNest } from './shell';
export { RemoteLoginShell, deviceByIp } from './remote';
export { FtpShell } from './ftpshell';
export { exampleActivities } from './activities';
export { runScript, type ScriptOptions, type ScriptResult } from './scripting';
export {
  TEMPLATES,
  templateById,
  buildTemplate,
  runTemplateChecks,
  Lab as TemplateLab,
  type Template,
  type TemplateCheck,
  type CheckResult,
} from './templates';
