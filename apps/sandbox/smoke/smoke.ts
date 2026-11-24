// Loads every sandbox scene in headless Chromium and fails on anything the engine or the browser reports.
import { expect, test } from '@playwright/test'
import { scenes } from '../src/scenes.ts'

for (const name of Object.keys(scenes)) {
  test(name, async ({ page }) => {
    const problems: string[] = []
    // A system the core disabled is logged through console.error, so this catches it too.
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
    })
    page.on('pageerror', (error) => problems.push(`uncaught: ${error.stack ?? error}`))
    page.on('requestfailed', (request) => problems.push(`${request.url()}: ${request.failure()?.errorText}`))
    page.on('response', (response) => {
      if (response.status() >= 400) problems.push(`${response.url()}: HTTP ${response.status()}`)
    })

    // Headless CI has no WebGPU.
    await page.goto(`/?scene=${name}&backend=webgl2`)
    const status = page.locator('#status')
    const running = new RegExp(`^${name} \\| WebGL2 \\| \\d+ FPS$`)
    // A scene that fails to load leaves its error in the status; poll() puts that text in the failure.
    await expect.poll(() => status.textContent()).toMatch(running)
    // The debug overlay prints the chunk count per state.
    if (name === 'world') await expect(page.getByText(/^ready [1-9]/)).toBeVisible()
    await page.waitForTimeout(2000)

    expect(problems).toEqual([])
    await expect(status).toHaveText(running, { timeout: 1000 })
    if (name === 'world') await expect(page.getByText('failed 0', { exact: true })).toBeVisible({ timeout: 1000 })
  })
}
