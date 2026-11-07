import type { Config } from '@react-router/dev/config'

export default {
  ssr: true,
  // Behind CloudFront the server sees the Web Function endpoint's hostname, not
  // the *.cloudfront.net domain the browser uses, so React Router's action
  // (POST) origin check would reject every form submit. The distribution's
  // domain is only known after deployment (and can't be passed in as an env
  // var without a circular CloudFormation dependency), hence the wildcard.
  // It still rejects every origin outside cloudfront.net. With a custom
  // domain, list it here exactly instead.
  allowedActionOrigins: ['*.cloudfront.net'],
} satisfies Config
