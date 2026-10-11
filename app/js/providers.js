/* ============================================================
 * providers.js — 一键切换的接口预设
 * ------------------------------------------------------------
 * 设计原则：让"能用"这件事的门槛降到最低。
 *   默认选中的是**免费**那家（智谱 GLM-4-Flash），
 *   新用户装完只要去注册个号、把 Key 粘进来就能聊，
 *   不用先充值、不用梯子。
 *
 * 每个预设都交代清楚"话会去哪儿"。说陪伴的话是很私人的事，
 * 用户有权知道它去了哪里 —— 这条不能省。
 *
 * ⚠️ tempMax：各家温度取值范围不同。
 *    智谱是 [0,1)，DeepSeek 是 [0,2]。暖屿默认 1.3（陪伴场景要一点随机），
 *    直接发给智谱会被接口以"参数非法"拒掉，所以这里按家夹紧。
 *
 * 注：这里只放**手机自己能直连**的云端接口。
 *    不放"电脑上跑模型"那类方案 —— 那需要在电脑上常驻服务，
 *    不是每个人都愿意；真要那样，用「自定义」自己填地址即可。
 * ============================================================ */
'use strict';

const PROVIDERS = [
  {
    id: 'glm',
    name: '智谱 GLM-4-Flash',
    tag: '免费',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    tempMax: 0.99,
    keyHint: '形如 xxxxxxxx.yyyyyyyy（不是 sk- 开头）',
    keyUrl: 'open.bigmodel.cn',
    note: '注册就能用，不要钱，也不用梯子。日常陪伴够用了。',
    privacy: '你说的话会发给智谱的服务器。'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    tag: '要说得好听选它',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    tempMax: 2,
    keyHint: 'sk- 开头',
    keyUrl: 'platform.deepseek.com',
    note: '目前安慰得最自然的一家。需要充值，但一次十块钱能用很久。',
    privacy: '你说的话会发给 DeepSeek 的服务器。'
  },
  {
    id: 'custom',
    name: '自定义',
    tag: '别的都行',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    tempMax: 2,
    keyHint: '看你的服务商要求',
    keyUrl: '',
    note: '任何 OpenAI 兼容接口都能用（通义、Kimi、豆包、公司内网、自己搭的……）。'
      + '地址填到 /v1 这一层就行，后面它会自己接 /chat/completions。',
    privacy: '你说的话会发给你填的那家。'
  }
];

function getProvider(id) {
  return PROVIDERS.find(function (p) { return p.id === id; }) || PROVIDERS[0];
}

/**
 * 按当前 baseUrl 反推是哪家。
 * 老用户升级上来时 providerId 可能是空的，或者用户手改过地址。
 */
function detectProvider(baseUrl) {
  if (!baseUrl) return PROVIDERS[0];
  const u = String(baseUrl);
  if (u.indexOf('bigmodel.cn') >= 0) return getProvider('glm');
  if (u.indexOf('deepseek.com') >= 0) return getProvider('deepseek');
  return getProvider('custom');
}

/** 按家的取值范围夹紧温度，避免被接口以参数非法拒掉 */
function clampTemperature(id, t) {
  const p = getProvider(id);
  const v = typeof t === 'number' && !isNaN(t) ? t : 1.3;
  return Math.min(Math.max(v, 0), p.tempMax - 0.01);
}

window.Providers = { PROVIDERS, getProvider, detectProvider, clampTemperature };
