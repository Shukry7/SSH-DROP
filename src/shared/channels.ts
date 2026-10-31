export const channels = {
  info: 'app:info',
  chooseKey: 'ssh:choose-key',
  connect: 'ssh:connect',
  disconnect: 'ssh:disconnect',
  list: 'sftp:list',
  upload: 'sftp:upload',
  download: 'sftp:download',
  cancel: 'transfer:cancel',
  input: 'terminal:input',
  acknowledge: 'terminal:acknowledge',
  resize: 'terminal:resize',
  event: 'session:event',
} as const;
