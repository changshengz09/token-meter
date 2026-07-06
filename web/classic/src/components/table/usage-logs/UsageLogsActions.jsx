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

import React from 'react';
import { Skeleton } from '@douyinfe/semi-ui';
import { Box, CircleDollarSign, Clock3, FileText } from 'lucide-react';
import { renderNumber, renderQuota } from '../../../helpers';
import { useMinimumLoadingTime } from '../../../hooks/common/useMinimumLoadingTime';
import { useActualTheme } from '../../../context/Theme';

const metricThemes = {
  request: {
    icon: FileText,
    light: {
      iconColor: '#2563eb',
      iconBackground: 'linear-gradient(135deg, #dbeafe 0%, #eff6ff 100%)',
      iconBorderColor: 'rgba(37, 99, 235, 0.16)',
      iconShadow: '0 8px 18px rgba(37, 99, 235, 0.12)',
    },
    dark: {
      iconColor: '#93c5fd',
      iconBackground: 'linear-gradient(135deg, rgba(37, 99, 235, 0.30) 0%, rgba(59, 130, 246, 0.18) 100%)',
      iconBorderColor: 'rgba(147, 197, 253, 0.24)',
      iconShadow: '0 10px 24px rgba(37, 99, 235, 0.22)',
    },
  },
  token: {
    icon: Box,
    light: {
      iconColor: '#d97706',
      iconBackground: 'linear-gradient(135deg, #fef3c7 0%, #fffbeb 100%)',
      iconBorderColor: 'rgba(217, 119, 6, 0.16)',
      iconShadow: '0 8px 18px rgba(217, 119, 6, 0.12)',
    },
    dark: {
      iconColor: '#fcd34d',
      iconBackground: 'linear-gradient(135deg, rgba(217, 119, 6, 0.30) 0%, rgba(251, 191, 36, 0.18) 100%)',
      iconBorderColor: 'rgba(252, 211, 77, 0.24)',
      iconShadow: '0 10px 24px rgba(217, 119, 6, 0.22)',
    },
  },
  cost: {
    icon: CircleDollarSign,
    light: {
      iconColor: '#059669',
      iconBackground: 'linear-gradient(135deg, #d1fae5 0%, #ecfdf5 100%)',
      iconBorderColor: 'rgba(5, 150, 105, 0.16)',
      iconShadow: '0 8px 18px rgba(5, 150, 105, 0.12)',
    },
    dark: {
      iconColor: '#6ee7b7',
      iconBackground: 'linear-gradient(135deg, rgba(5, 150, 105, 0.30) 0%, rgba(16, 185, 129, 0.18) 100%)',
      iconBorderColor: 'rgba(110, 231, 183, 0.24)',
      iconShadow: '0 10px 24px rgba(5, 150, 105, 0.22)',
    },
  },
  duration: {
    icon: Clock3,
    light: {
      iconColor: '#7c3aed',
      iconBackground: 'linear-gradient(135deg, #ede9fe 0%, #f5f3ff 100%)',
      iconBorderColor: 'rgba(124, 58, 237, 0.16)',
      iconShadow: '0 8px 18px rgba(124, 58, 237, 0.12)',
    },
    dark: {
      iconColor: '#c4b5fd',
      iconBackground: 'linear-gradient(135deg, rgba(124, 58, 237, 0.30) 0%, rgba(167, 139, 250, 0.18) 100%)',
      iconBorderColor: 'rgba(196, 181, 253, 0.24)',
      iconShadow: '0 10px 24px rgba(124, 58, 237, 0.22)',
    },
  },
};

const safeNumber = (value) => {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
};

const formatMetricNumber = (value) => {
  const numericValue = safeNumber(value);
  if (numericValue === 0) {
    return '0';
  }
  const formattedValue = renderNumber(numericValue);
  if (typeof formattedValue === 'string') {
    return formattedValue.replace(/k/g, 'K').replace(/m/g, 'M');
  }
  return String(formattedValue);
};

const formatPercent = (value) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return '—';
  }
  return `${(numericValue * 100).toFixed(1)}%`;
};

const formatDuration = (value) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return '—';
  }
  return `${numericValue.toFixed(2)}s`;
};

const MetricCard = ({ theme, title, value, subLines, actualTheme }) => {
  const ThemeIcon = theme.icon;
  const iconTheme = actualTheme === 'dark' ? theme.dark : theme.light;

  return (
    <div
      className='relative overflow-hidden rounded-2xl border p-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg'
      style={{
        minHeight: 126,
        background:
          'linear-gradient(180deg, var(--semi-color-bg-0) 0%, var(--semi-color-bg-1) 100%)',
        borderColor: 'var(--semi-color-border)',
        boxShadow: actualTheme === 'dark'
          ? '0 10px 28px rgba(2, 6, 23, 0.32)'
          : '0 8px 24px rgba(15, 23, 42, 0.06)',
      }}
    >
      <div className='relative flex items-start gap-3'>
        <div
          className='flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border'
          style={{
            background: iconTheme.iconBackground,
            borderColor: iconTheme.iconBorderColor,
            boxShadow: iconTheme.iconShadow,
          }}
        >
          <ThemeIcon
            size={22}
            strokeWidth={2.2}
            style={{ color: iconTheme.iconColor }}
          />
        </div>
        <div className='min-w-0 flex-1'>
          <div className='text-sm font-medium' style={{ color: 'var(--semi-color-text-2)' }}>
            {title}
          </div>
          <div
            className='mt-1 truncate text-2xl font-bold leading-tight'
            style={{
              color: 'var(--semi-color-text-0)',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.02em',
            }}
          >
            {value}
          </div>
          <div className='mt-1 space-y-0.5 text-xs leading-5' style={{ color: 'var(--semi-color-text-2)' }}>
            {subLines.filter(Boolean).map((line, index) => (
              <div key={index} className='truncate'>
                {line}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const LogsActions = ({
  stat,
  loadingStat,
  showStat,
  t,
}) => {
  const showSkeleton = useMinimumLoadingTime(loadingStat);
  const actualTheme = useActualTheme();
  const cacheLineColor = actualTheme === 'dark' ? '#93c5fd' : '#60a5fa';
  const needSkeleton = !showStat || showSkeleton;
  const cacheLines = [
    t('缓存命中 {{value}}', { value: formatMetricNumber(stat.cache_hit_tokens) }),
    safeNumber(stat.cache_write_tokens) > 0
      ? t('缓存写入 {{value}}', { value: formatMetricNumber(stat.cache_write_tokens) })
      : '',
    t('命中率 {{value}}', { value: formatPercent(stat.cache_hit_rate) }),
  ].filter(Boolean);
  const spendSubLine =
    stat.standard_quota !== null && stat.standard_quota !== undefined
      ? t('实际 {{actual}} / {{standard}} 标准', {
          actual: renderQuota(stat.actual_quota ?? stat.quota, 4),
          standard: renderQuota(stat.standard_quota, 4),
        })
      : t('基于筛选后的消费日志汇总');

  const cards = [
    {
      key: 'request',
      theme: metricThemes.request,
      title: t('总请求数'),
      value: formatMetricNumber(stat.request_count),
      subLines: [t('仅统计消费日志')],
    },
    {
      key: 'token',
      theme: metricThemes.token,
      title: t('总 Token'),
      value: formatMetricNumber(stat.token_total),
      subLines: [
        `${t('输入 {{value}}', { value: formatMetricNumber(stat.input_tokens) })} · ${t('输出 {{value}}', { value: formatMetricNumber(stat.output_tokens) })}`,
        <span style={{ color: cacheLineColor }}>{cacheLines.join(' · ')}</span>,
      ],
    },
    {
      key: 'cost',
      theme: metricThemes.cost,
      title: t('总消费'),
      value: renderQuota(stat.quota, 4),
      subLines: [spendSubLine],
    },
    {
      key: 'duration',
      theme: metricThemes.duration,
      title: t('平均耗时'),
      value: formatDuration(stat.avg_duration_seconds),
      subLines: [t('每次请求')],
    },
  ];

  const placeholder = (
    <div className='grid w-full grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4'>
      {[0, 1, 2, 3].map((item) => (
        <div
          key={item}
          className='rounded-2xl border p-4'
          style={{ borderColor: 'var(--semi-color-border)', minHeight: 126 }}
        >
          <div className='flex items-start gap-3'>
            <Skeleton.Avatar active size='large' />
            <div className='flex-1'>
              <Skeleton.Title style={{ width: 72, height: 16, borderRadius: 6 }} />
              <Skeleton.Title style={{ width: 108, height: 30, borderRadius: 8, marginTop: 8 }} />
              <Skeleton.Paragraph rows={2} style={{ width: '100%', marginTop: 8 }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className='flex w-full flex-col gap-3'>
      <Skeleton loading={needSkeleton} active placeholder={placeholder}>
        <div className='grid w-full grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4' aria-busy={loadingStat}>
          {cards.map((card) => (
            <MetricCard key={card.key} {...card} actualTheme={actualTheme} />
          ))}
        </div>
      </Skeleton>
    </div>
  );
};

export default LogsActions;
