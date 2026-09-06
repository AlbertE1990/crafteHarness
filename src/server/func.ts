// Mock 工具函数：返回字段与 tools.json 中各工具 description 声明的返回结构一一对应
interface WeatherPreset {
  weather: string
  temperature_c: number
  feels_like_c: number
  humidity_percent: number
  wind_direction: string
  wind_scale: number
}

const weatherPresets: Record<string, WeatherPreset> = {
  杭州: { weather: '多云', temperature_c: 26, feels_like_c: 28, humidity_percent: 72, wind_direction: '东南风', wind_scale: 3 },
  北京: { weather: '晴', temperature_c: 21, feels_like_c: 20, humidity_percent: 38, wind_direction: '北风', wind_scale: 2 },
  上海: { weather: '小雨', temperature_c: 24, feels_like_c: 26, humidity_percent: 85, wind_direction: '东风', wind_scale: 4 },
}

const defaultWeather: WeatherPreset = {
  weather: '多云',
  temperature_c: 25,
  feels_like_c: 26,
  humidity_percent: 60,
  wind_direction: '东南风',
  wind_scale: 3,
}

export default {
  // 模型传入的参数是一个对象（OpenAI 协议），对应 tools.json 中 get_time 的 parameters
  // get_time(_args?: { amount?: number, unit?: string, preset?: string, timezone?: string }): string {
  //   return '2026/9/5 23:16:32'
  // },

  // 对应 tools.json 中的 get_user_location（无参数）
  get_user_location() {
    return {
      ip: '203.0.113.42',
      country: '中国',
      province: '浙江省',
      city: '杭州市', // 模型调用天气工具时会直接使用此值
      district: '西湖区',
      latitude: 30.2741,
      longitude: 120.1551,
    }
  },

  // 对应 tools.json 中的 get_weather（city 可选），参数为 { city?: string }
  get_weather(args?: { city?: string }) {
    const target = args?.city?.trim() || '杭州市'
    // 归一化掉「市」后缀后再查预设，返回时保留模型传入的原始写法
    const preset = weatherPresets[target.replace(/市$/, '')] ?? defaultWeather
    return {
      city: target,
      ...preset,
      observed_at: new Date().toISOString(),
    }
  },
} as Record<string, any>
