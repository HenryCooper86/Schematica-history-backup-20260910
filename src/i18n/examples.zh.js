// Simplified Chinese overlays for the built-in example boards, keyed by
// example id, then by node / zone / note / journey id. Only text translates:
// labels, notes, zone labels and lane names, note text, journey labels and
// captions. Part numbers (sublabels), fields, ids and geometry never appear
// here. localizedExample() in src/examples.js applies an overlay to a copy.
export default {
  'weather-station': {
    name: '气象站',
    title: '气象站',
    nodes: {
      n1: { label: '太阳能板' },
      n2: { label: '充电器' },
      n3: { label: '电池' },
      n4: { label: '稳压器' },
      n5: { label: '微控制器', notes: '读数之间深度睡眠；每 10 分钟唤醒一次。' },
      n6: { label: '温度传感器' },
      n7: { label: '土壤探头' },
      n8: { label: 'WiFi / 蓝牙' },
    },
    zones: { z1: { label: '电源' }, z2: { label: '传感器舱' } },
    notes: { t1: '所有逻辑都运行在 3.3V 电压轨上' },
    journey: {
      j1: { label: '供电路径', caption: '阳光通过 TP4056 为锂聚合物电池充电；LDO 提供干净的 3.3V 电压轨。' },
      j2: { label: '大脑', caption: 'ESP32-S3 轮询各传感器，并通过 WiFi 将读数上传。' },
      j3: { label: '传感器', caption: 'BME280 共用 I2C 总线；土壤探头直接接入 ADC。' },
    },
  },
};
