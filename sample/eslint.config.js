import antfu from '@antfu/eslint-config'

export default antfu(
  {
    unocss: true,
    formatters: true,
    pnpm: true,
    ignores: ['dist/**', 'dist-server/**', '.runtime/**'],
  },
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'log', 'dir'] }],
    },
  },
)
