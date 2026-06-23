export function isCloudE2eTestModeEnabled(): boolean {
  return process.env.REBEL_E2E_TEST_MODE === '1'
    && process.env.NODE_ENV !== 'production'
    && !process.env.FLY_APP_NAME
    && !process.env.FLY_MACHINE_ID
    && !process.env.FLY_IMAGE_REF;
}
