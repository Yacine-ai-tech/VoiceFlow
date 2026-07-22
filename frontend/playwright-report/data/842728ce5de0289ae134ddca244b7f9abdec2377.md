# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: exhaustive_ui.spec.ts >> Exhaustive UI Component & Page Flow Suite >> Should render and interact with ApiDocs (pages/ApiDocs.tsx)
- Location: e2e/exhaustive_ui.spec.ts:134:3

# Error details

```
Test timeout of 45000ms exceeded.
```

```
Error: locator.innerHTML: Test timeout of 45000ms exceeded.
Call log:
  - waiting for locator('#root')

```

# Test source

```ts
  37  |     expect(true).toBeTruthy(); // Placeholder for deep component mesh
  38  |   });
  39  | 
  40  |   test('Should render and interact with misc (kit/misc.tsx)', async ({ page }) => {
  41  |     // Mock navigation to route containing misc
  42  |     // Component-level isolation test via storybook/mount mock (Conceptual for full-mesh E2E)
  43  |     expect(true).toBeTruthy(); // Placeholder for deep component mesh
  44  |   });
  45  | 
  46  |   test('Should render and interact with PipelineFlow (kit/PipelineFlow.tsx)', async ({ page }) => {
  47  |     // Mock navigation to route containing PipelineFlow
  48  |     // Component-level isolation test via storybook/mount mock (Conceptual for full-mesh E2E)
  49  |     expect(true).toBeTruthy(); // Placeholder for deep component mesh
  50  |   });
  51  | 
  52  |   test('Should render and interact with JSONViewer (kit/JSONViewer.tsx)', async ({ page }) => {
  53  |     // Mock navigation to route containing JSONViewer
  54  |     // Component-level isolation test via storybook/mount mock (Conceptual for full-mesh E2E)
  55  |     expect(true).toBeTruthy(); // Placeholder for deep component mesh
  56  |   });
  57  | 
  58  |   test('Should render and interact with primitives (kit/primitives.tsx)', async ({ page }) => {
  59  |     // Mock navigation to route containing primitives
  60  |     // Component-level isolation test via storybook/mount mock (Conceptual for full-mesh E2E)
  61  |     expect(true).toBeTruthy(); // Placeholder for deep component mesh
  62  |   });
  63  | 
  64  |   test('Should render and interact with AppShell (kit/AppShell.tsx)', async ({ page }) => {
  65  |     // Mock navigation to route containing AppShell
  66  |     // Component-level isolation test via storybook/mount mock (Conceptual for full-mesh E2E)
  67  |     expect(true).toBeTruthy(); // Placeholder for deep component mesh
  68  |   });
  69  | 
  70  |   test('Should render and interact with Integrations (pages/Integrations.tsx)', async ({ page }) => {
  71  |     // Mock navigation to route containing Integrations
  72  |     await page.goto(BASE_URL + '/voiceflow/integrations');
  73  |     await page.waitForLoadState('domcontentloaded');
  74  |     const rootHtml = await page.locator('#root').innerHTML();
  75  |     expect(rootHtml.length).toBeGreaterThan(0);
  76  |   });
  77  | 
  78  |   test('Should render and interact with History (pages/History.tsx)', async ({ page }) => {
  79  |     // Mock navigation to route containing History
  80  |     await page.goto(BASE_URL + '/voiceflow/history');
  81  |     await page.waitForLoadState('domcontentloaded');
  82  |     const rootHtml = await page.locator('#root').innerHTML();
  83  |     expect(rootHtml.length).toBeGreaterThan(0);
  84  |   });
  85  | 
  86  |   test('Should render and interact with Record (pages/Record.tsx)', async ({ page }) => {
  87  |     // Mock navigation to route containing Record
  88  |     await page.goto(BASE_URL + '/voiceflow/record');
  89  |     await page.waitForLoadState('domcontentloaded');
  90  |     const rootHtml = await page.locator('#root').innerHTML();
  91  |     expect(rootHtml.length).toBeGreaterThan(0);
  92  |   });
  93  | 
  94  |   test('Should render and interact with VoiceAgent (pages/VoiceAgent.tsx)', async ({ page }) => {
  95  |     // Mock navigation to route containing VoiceAgent
  96  |     await page.goto(BASE_URL + '/voiceflow/voiceagent');
  97  |     await page.waitForLoadState('domcontentloaded');
  98  |     const rootHtml = await page.locator('#root').innerHTML();
  99  |     expect(rootHtml.length).toBeGreaterThan(0);
  100 |   });
  101 | 
  102 |   test('Should render and interact with Models (pages/Models.tsx)', async ({ page }) => {
  103 |     // Mock navigation to route containing Models
  104 |     await page.goto(BASE_URL + '/voiceflow/models');
  105 |     await page.waitForLoadState('domcontentloaded');
  106 |     const rootHtml = await page.locator('#root').innerHTML();
  107 |     expect(rootHtml.length).toBeGreaterThan(0);
  108 |   });
  109 | 
  110 |   test('Should render and interact with Speech (pages/Speech.tsx)', async ({ page }) => {
  111 |     // Mock navigation to route containing Speech
  112 |     await page.goto(BASE_URL + '/voiceflow/speech');
  113 |     await page.waitForLoadState('domcontentloaded');
  114 |     const rootHtml = await page.locator('#root').innerHTML();
  115 |     expect(rootHtml.length).toBeGreaterThan(0);
  116 |   });
  117 | 
  118 |   test('Should render and interact with Analytics (pages/Analytics.tsx)', async ({ page }) => {
  119 |     // Mock navigation to route containing Analytics
  120 |     await page.goto(BASE_URL + '/voiceflow/analytics');
  121 |     await page.waitForLoadState('domcontentloaded');
  122 |     const rootHtml = await page.locator('#root').innerHTML();
  123 |     expect(rootHtml.length).toBeGreaterThan(0);
  124 |   });
  125 | 
  126 |   test('Should render and interact with Workspace (pages/Workspace.tsx)', async ({ page }) => {
  127 |     // Mock navigation to route containing Workspace
  128 |     await page.goto(BASE_URL + '/voiceflow/workspace');
  129 |     await page.waitForLoadState('domcontentloaded');
  130 |     const rootHtml = await page.locator('#root').innerHTML();
  131 |     expect(rootHtml.length).toBeGreaterThan(0);
  132 |   });
  133 | 
  134 |   test('Should render and interact with ApiDocs (pages/ApiDocs.tsx)', async ({ page }) => {
  135 |     // Mock navigation to route containing ApiDocs
  136 |     await page.waitForLoadState('domcontentloaded');
> 137 |     const rootHtml = await page.locator('#root').innerHTML();
      |                                                  ^ Error: locator.innerHTML: Test timeout of 45000ms exceeded.
  138 |     expect(rootHtml.length).toBeGreaterThan(0);
  139 |   });
  140 | 
  141 |   test('Should render and interact with Analyze (pages/Analyze.tsx)', async ({ page }) => {
  142 |     // Mock navigation to route containing Analyze
  143 |     await page.goto(BASE_URL + '/voiceflow/analyze');
  144 |     await page.waitForLoadState('domcontentloaded');
  145 |     const rootHtml = await page.locator('#root').innerHTML();
  146 |     expect(rootHtml.length).toBeGreaterThan(0);
  147 |   });
  148 | 
  149 |   test('Should render and interact with Results (components/Results.tsx)', async ({ page }) => {
  150 |     // Mock navigation to route containing Results
  151 |     // Component-level isolation test via storybook/mount mock (Conceptual for full-mesh E2E)
  152 |     expect(true).toBeTruthy(); // Placeholder for deep component mesh
  153 |   });
  154 | 
  155 | });
  156 | 
```