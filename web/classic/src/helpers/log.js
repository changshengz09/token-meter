/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

export function getLogOther(otherStr) {
  if (otherStr === undefined || otherStr === null || otherStr === '') {
    return {};
  }
  if (typeof otherStr === 'object') {
    return otherStr;
  }
  try {
    return JSON.parse(otherStr);
  } catch (e) {
    console.error(`Failed to parse record.other: "${otherStr}".`, e);
    return null;
  }
}

// 订阅套餐 title_i18n 支持的语言码，与后端 subscriptionLangs / 前端 locale 码保持一致。
export const SUBSCRIPTION_PLAN_LANGS = [
  'zh-CN',
  'zh-TW',
  'en',
  'fr',
  'ru',
  'ja',
  'vi',
];

// localizeSubscriptionPlanTitle 从日志中保存的 i18n JSON 快照按当前界面语言取套餐名，
// 缺失时回退到旧的单一标题字段。
export function localizeSubscriptionPlanTitle(rawI18n, fallback, lang) {
  const fb = fallback || '';
  if (!rawI18n) return fb;
  let map = rawI18n;
  if (typeof rawI18n === 'string') {
    try {
      map = JSON.parse(rawI18n);
    } catch {
      return fb;
    }
  }
  if (!map || typeof map !== 'object') return fb;
  const code = String(lang || '').trim();
  if (code && SUBSCRIPTION_PLAN_LANGS.includes(code)) {
    const v = map[code];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return fb;
}
