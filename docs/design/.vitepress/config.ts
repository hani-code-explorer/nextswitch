import { defineConfig } from 'vitepress'
import type { Plugin } from 'vite'
import { readFileSync } from 'fs'

const LT = '\u2020'
const GT = '\u2021'

function escapeAngleBrackets(code: string): string {
  return code.replace(/</g, LT).replace(/>/g, GT)
}

function replacePlaceholders(s: string): string {
  return s.replace(/\u2020/g, '&lt;').replace(/\u2021/g, '&gt;')
}

function angleBracketPlugin(): Plugin {
  return {
    name: 'angle-bracket-escape',
    enforce: 'pre',
    load(id) {
      if (id.endsWith('.md')) {
        const raw = readFileSync(id.replace(/\?.*$/, ''), 'utf-8')
        return escapeAngleBrackets(raw)
      }
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') {
          if (chunk.code.includes(LT) || chunk.code.includes(GT)) {
            chunk.code = replacePlaceholders(chunk.code)
          }
        } else {
          const source = chunk.source as string
          if (source && (source.includes(LT) || source.includes(GT))) {
            chunk.source = replacePlaceholders(source)
          }
        }
      }
    },
  }
}

export default defineConfig({
  title: 'NextSWITCH',
  description: 'NextSWITCH 企业级 IP PBX / 呼叫管理平台设计文档',
  lang: 'zh-CN',

  vite: {
    plugins: [angleBracketPlugin()],
  },

  transformHtml(code) {
    if (code.includes(LT) || code.includes(GT)) {
      return replacePlaceholders(code)
    }
  },

  themeConfig: {
    logo: undefined,

    nav: [
      { text: '首页', link: '/' },
      { text: '整体设计', link: '/spec/overall/' },
      { text: '服务设计', link: '/spec/application/' },
      { text: '应用设计', link: '/spec/apps/' },
      { text: '模块设计', link: '/spec/modules/' },
      { text: '安全设计', link: '/spec/security/' },
      { text: '配置与网关', link: '/spec/config/' },
      { text: '监控与运维', link: '/spec/monitoring/' },
      { text: '部署', link: '/deploy' },
    ],

    sidebar: {
      '/spec/overall/': [
        {
          text: '整体设计',
          items: [
            { text: '概述', link: '/spec/overall/' },
            { text: '平台架构', link: '/spec/overall/architecture' },
          ],
        },
      ],
      '/spec/application/': [
        {
          text: '概述',
          link: '/spec/application/',
        },
        {
          text: '信令服务器',
          collapsed: true,
          items: [
            { text: '概述', link: '/spec/application/signaling/' },
            { text: '总体设计', link: '/spec/application/signaling/design' },
            { text: '信令交互设计', link: '/spec/application/signaling/interaction' },
            {
              text: 'SIP服务设计',
              collapsed: true,
              items: [
                { text: '概述', link: '/spec/application/signaling/sipserver' },
                { text: 'Transport 层设计', link: '/spec/application/signaling/sipserver/transport' },
                { text: 'Pre-Route 管线', link: '/spec/application/signaling/sipserver/preroute' },
                { text: 'SIP 方法处理', link: '/spec/application/signaling/sipserver/methods' },
                { text: 'Proxy 模块', link: '/spec/application/signaling/sipserver/proxy' },
                { text: 'Registrar 模块', link: '/spec/application/signaling/sipserver/registrar' },
                { text: 'Dialog 模块', link: '/spec/application/signaling/sipserver/dialog' },
                { text: 'CDR 生成', link: '/spec/application/signaling/sipserver/cdr' },
                { text: '心跳机制', link: '/spec/application/signaling/sipserver/heartbeat' },
              ],
            },
            {
              text: 'WS/WSS 服务设计',
              collapsed: true,
              items: [
                { text: '概述', link: '/spec/application/signaling/sigserver' },
                { text: 'WebSocket 传输层', link: '/spec/application/signaling/sigserver/websocket' },
                { text: '呼叫状态机', link: '/spec/application/signaling/sigserver/state-machine' },
                { text: 'WebRTC 媒体协商', link: '/spec/application/signaling/sigserver/webrtc' },
              ],
            },
          ],
        },
        {
          text: '媒体服务器',
          collapsed: true,
          items: [
            { text: '概述', link: '/spec/application/media/' },
            { text: '媒体服务器设计', link: '/spec/application/media/design' },
            { text: 'gRPC 接口', link: '/spec/application/media/interface' },
          ],
        },
        {
          text: '路由引擎',
          collapsed: true,
          items: [
            { text: '概述', link: '/spec/application/routing/' },
            { text: '路由引擎设计', link: '/spec/application/routing/design' },
          ],
        },
        {
          text: 'CTI 服务',
          collapsed: true,
          items: [
            { text: '概述', link: '/spec/application/cti/' },
            { text: 'CTI 服务设计', link: '/spec/application/cti/design' },
            { text: 'CTI API 规范', link: '/spec/application/cti/api' },
          ],
        },
        {
          text: 'IM 服务',
          collapsed: true,
          items: [
            { text: '概述', link: '/spec/application/im/' },
            { text: 'IM 服务设计', link: '/spec/application/im/design' },
          ],
        },
      ],
      '/spec/security/': [
        {
          text: '安全设计',
          items: [
            { text: '概述', link: '/spec/security/' },
            { text: '平台安全', link: '/spec/security/platform-security' },
            { text: '信令安全', link: '/spec/security/signaling-security' },
          ],
        },
      ],
      '/spec/config/': [
        {
          text: '配置与网关',
          items: [
            { text: '概述', link: '/spec/config/' },
            { text: '配置中心与 API 网关', link: '/spec/config/config-and-gateway' },
            { text: '信令配置管理', link: '/spec/config/signaling-config' },
          ],
        },
      ],
      '/spec/monitoring/': [
        {
          text: '监控与运维',
          items: [
            { text: '概述', link: '/spec/monitoring/' },
            { text: '监控设计', link: '/spec/monitoring/monitoring-design' },
            { text: '压测工具', link: '/spec/monitoring/stress-test-tool' },
          ],
        },
      ],
      '/spec/apps/': [
        {
          text: '应用设计',
          items: [
            { text: '概述', link: '/spec/apps/' },
            { text: 'sipserver', link: '/spec/apps/sipserver/' },
            { text: 'sigserver', link: '/spec/apps/sigserver/' },
            { text: 'medserver', link: '/spec/apps/medserver/' },
            { text: 'cti-server', link: '/spec/apps/cti-server/' },
            { text: 'im-server', link: '/spec/apps/im-server/' },
            { text: 'config-server', link: '/spec/apps/config-server/' },
            { text: 'api-gateway', link: '/spec/apps/api-gateway/' },
          ],
        },
      ],
      '/spec/modules/': [
        {
          text: '模块设计',
          items: [
            { text: '概述', link: '/spec/modules/' },
            { text: 'nextswitch-core', link: '/spec/modules/nextswitch-core/' },
            { text: 'nextswitch-sip', link: '/spec/modules/nextswitch-sip/' },
            { text: 'nextswitch-media', link: '/spec/modules/nextswitch-media/' },
            { text: 'nextswitch-api', link: '/spec/modules/nextswitch-api/' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/nextswitch/nextswitch' },
    ],

    footer: {
      message: 'NextSWITCH 企业级 IP PBX / 呼叫管理平台设计文档',
      copyright: 'Copyright © 2026 NextSWITCH',
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档',
          },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },

    outline: {
      label: '页面导航',
    },

    docFooter: {
      prev: '上一页',
      next: '下一页',
    },

    lastUpdated: {
      text: '最后更新',
    },
  },
})
