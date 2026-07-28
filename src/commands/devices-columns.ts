export const DEVICE_FIELD_ALIAS: Record<string, string> = {
  id: 'deviceId', name: 'deviceName', deviceType: 'type', type: 'type',
  roomName: 'room', familyName: 'family', hubDeviceId: 'hub',
  enableCloudService: 'cloud', controlType: 'controlType',
  deviceName: 'deviceName', deviceId: 'deviceId', category: 'category',
  roomID: 'roomID', alias: 'alias',
};

export const DEVICE_ALL_COLS: Set<string> = new Set([
  'deviceId', 'deviceName', 'type', 'category', 'controlType',
  'family', 'roomID', 'room', 'hub', 'cloud', 'alias',
]);
