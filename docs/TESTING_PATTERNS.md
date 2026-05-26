# TypeScript/Node.js Service Testing & Integration Patterns

**Date**: May 17, 2026  
**Scope**: Vitest test scaffolding, Node.js HTTP API testing, CLI subcommand testing, structured JSON error responses  
**Target**: Vibesync service (test scaffolding, API routes, CLI verbs, E2E smoke tests)

---

## 1. ACTUAL TECH STACK

Based on package.json and codebase inspection:

| Component | Library | Status |
|-----------|---------|--------|
| **Runtime** | Node.js 20+ / Bun 1.2.10+ | Primary |
| **HTTP Framework** | Node.js native `http` module | Current (custom routing) |
| **Test Runner** | Vitest 4.0.6+ | Primary (Jest-compatible) |
| **HTTP Testing** | Supertest 7.1.4+ | For API route testing |
| **Package Manager** | Bun | Primary |
| **CLI Framework** | Commander 14.0.3+ | For subcommands |

---

## 2. VITEST TEST SCAFFOLDING

### 2.1 Basic Test Structure

**Reference**: [Vitest Documentation](https://vitest.dev/)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('Feature Name', () => {
  beforeEach(() => {
    // Setup before each test
  })

  afterEach(() => {
    // Cleanup after each test
  })

  it('should do something', () => {
    expect(true).toBe(true)
  })

  it('should handle async', async () => {
    const result = await someAsyncFunction()
    expect(result).toEqual({ expected: 'value' })
  })
})
```

**Key Features**:
- ✅ Jest-compatible `expect()` API
- ✅ Built-in snapshot testing
- ✅ Watch mode & lifecycle hooks (`beforeEach`, `afterEach`, `beforeAll`, `afterAll`)
- ✅ Concurrent test execution (configurable)
- ✅ Built-in code coverage (`vitest run --coverage`)
- ✅ HTML reporter (`vitest --ui`)

**Real Example** (from Vibesync tests):
```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { createSyncDatabase } from '../src/database'

describe('SyncDatabase', () => {
  let db: ReturnType<typeof createSyncDatabase>

  beforeAll(() => {
    db = createSyncDatabase(':memory:')
  })

  it('should initialize database', () => {
    expect(db).toBeDefined()
  })
})
```

### 2.2 Running Tests

```bash
# Run all tests
bun run test
# or
vitest run

# Watch mode
bun run test:watch
# or
vitest

# Coverage report
bun run test:coverage
# or
vitest run --coverage

# Specific file
vitest run tests/unit/MyFeature.test.ts

# UI mode
bun run test:ui
# or
vitest --ui

# Filter by test name
vitest run --grep "should handle"

# Unit tests only
bun run test:unit

# Integration tests only
bun run test:integration
```

### 2.3 Test Configuration

**Reference**: [vitest.config.js](../vitest.config.js)

```javascript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 2,
        execArgv: ['--max-old-space-size=2048'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
    testTimeout: 30000,
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{js,ts}'],
  },
})
```

---

## 3. NODE.JS HTTP API TESTING

### 3.1 Testing with Supertest

**Reference**: [Supertest Documentation](https://github.com/visionmedia/supertest)

```typescript
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApiServer } from '../src/ApiServer'

describe('GET /api/projects', () => {
  it('should return projects list', async () => {
    const app = createApiServer(/* config */)
    
    const res = await request(app)
      .get('/api/projects')
      .expect('Content-Type', /json/)
      .expect(200)
    
    expect(res.body).toHaveProperty('projects')
    expect(Array.isArray(res.body.projects)).toBe(true)
  })

  it('should handle query parameters', async () => {
    const app = createApiServer(/* config */)
    
    const res = await request(app)
      .get('/api/projects')
      .query({ limit: 10, offset: 0 })
      .expect(200)
    
    expect(res.body.projects.length).toBeLessThanOrEqual(10)
  })
})
```

**Key Patterns**:
- ✅ Chainable API for building requests
- ✅ Automatic assertion helpers (`.expect()`)
- ✅ JSON body parsing
- ✅ Header validation
- ✅ Status code assertions

### 3.2 Testing POST/PATCH with Request Body

```typescript
describe('POST /api/projects', () => {
  it('should create a project', async () => {
    const app = createApiServer(/* config */)
    
    const res = await request(app)
      .post('/api/projects')
      .set('Content-Type', 'application/json')
      .send({
        filesystem_path: '/opt/stacks/test-project',
        name: 'Test Project',
        git_url: 'https://github.com/test/project.git',
      })
      .expect(201)
    
    expect(res.body).toHaveProperty('id')
    expect(res.body.name).toBe('Test Project')
  })

  it('should validate required fields', async () => {
    const app = createApiServer(/* config */)
    
    const res = await request(app)
      .post('/api/projects')
      .send({
        name: 'Test Project',
        // Missing filesystem_path
      })
      .expect(400)
    
    expect(res.body.error).toBeDefined()
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})
```

### 3.3 Testing with Authentication/Headers

```typescript
describe('Protected Routes', () => {
  it('should require authorization header', async () => {
    const app = createApiServer(/* config */)
    
    const res = await request(app)
      .get('/api/admin/config')
      .expect(401)
  })

  it('should accept valid token', async () => {
    const app = createApiServer(/* config */)
    
    const res = await request(app)
      .get('/api/admin/config')
      .set('Authorization', 'Bearer valid-token')
      .expect(200)
  })
})
```

---

## 4. STRUCTURED JSON ERROR RESPONSES

### 4.1 Standard Error Response Pattern

**Reference**: [REST API Error Design Best Practices (2026)](https://www.speakeasy.com/api-design/errors)

```typescript
// Error response shape
interface ApiErrorResponse {
  error: {
    code: string           // Machine-readable code (e.g., 'VALIDATION_ERROR')
    message: string        // Human-readable message
    details?: Record<string, unknown>  // Field-level errors
    timestamp: string      // ISO 8601
    requestId?: string     // For tracing
  }
}

// Example
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": {
      "filesystem_path": "Path must be absolute",
      "name": "Name is required"
    },
    "timestamp": "2026-05-17T10:30:00Z",
    "requestId": "req_abc123"
  }
}
```

### 4.2 Node.js HTTP Error Handler Pattern

```typescript
import http from 'http'

interface ApiError extends Error {
  status?: number
  code?: string
  details?: Record<string, unknown>
}

function sendErrorResponse(
  res: http.ServerResponse,
  error: ApiError,
  requestId?: string
): void {
  const status = error.status || 500
  const code = error.code || 'INTERNAL_ERROR'
  
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    error: {
      code,
      message: error.message,
      details: error.details,
      timestamp: new Date().toISOString(),
      requestId,
    },
  }))
}

// Usage in route handler
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const requestId = req.headers['x-request-id'] as string
    
    if (req.method === 'POST' && req.url === '/api/projects') {
      // Validate request
      if (!body.filesystem_path) {
        const err: ApiError = new Error('Validation failed')
        err.status = 400
        err.code = 'VALIDATION_ERROR'
        err.details = { filesystem_path: 'Required field' }
        throw err
      }
      
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 1, name: body.name }))
    }
  } catch (err) {
    sendErrorResponse(res, err as ApiError, req.headers['x-request-id'] as string)
  }
}
```

### 4.3 Testing Error Responses

```typescript
describe('Error Handling', () => {
  it('should return structured error on validation failure', async () => {
    const app = createApiServer(/* config */)
    
    const res = await request(app)
      .post('/api/projects')
      .send({
        name: 'Test Project',
        // Missing filesystem_path
      })
      .expect(400)
    
    expect(res.body.error).toBeDefined()
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.details.filesystem_path).toBeDefined()
    expect(res.body.error.timestamp).toBeDefined()
  })

  it('should include request ID in error response', async () => {
    const app = createApiServer(/* config */)
    
    const res = await request(app)
      .post('/api/projects')
      .set('X-Request-ID', 'test-123')
      .send({})
      .expect(400)
    
    expect(res.body.error.requestId).toBe('test-123')
  })
})
```

---

## 5. CLI SUBCOMMAND TESTING

### 5.1 CLI Framework: Commander

**Reference**: [Commander.js Documentation](https://github.com/tj/commander.js)

**Current Usage** (from package.json):
```typescript
import { Command } from 'commander'

const program = new Command()
  .name('vibesync')
  .version('1.0.0')
  .description('Project sync service with PM agent orchestration')

// Subcommand: vibesync project-beads-remote
program
  .command('project-beads-remote <projectId>')
  .description('Get Beads remote configuration for a project')
  .action(async (projectId) => {
    console.log(`Getting Beads remote for project: ${projectId}`)
  })

// Subcommand: vibesync project-provision-beads-remote
program
  .command('project-provision-beads-remote <projectId>')
  .option('--no-push', 'Do not push to remote')
  .description('Provision Beads remote for a project')
  .action(async (projectId, options) => {
    console.log(`Provisioning Beads remote for project: ${projectId}`)
    if (options.push) {
      console.log('Will push to remote')
    }
  })

program.parse(process.argv)
```

### 5.2 CLI Testing Pattern

```typescript
import { describe, it, expect } from 'vitest'
import { spawn } from 'bun'

describe('CLI: vibesync', () => {
  it('should show help', async () => {
    const proc = spawn(['bun', 'src/cli.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    
    const output = await new Response(proc.stdout).text()
    expect(output).toContain('vibesync')
    expect(output).toContain('Project sync service')
  })

  it('should execute project-beads-remote command', async () => {
    const proc = spawn(['bun', 'src/cli.ts', 'project-beads-remote', 'HVSYN'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    
    const output = await new Response(proc.stdout).text()
    expect(output).toContain('Getting Beads remote for project: HVSYN')
  })

  it('should handle --no-push option', async () => {
    const proc = spawn(
      ['bun', 'src/cli.ts', 'project-provision-beads-remote', 'HVSYN', '--no-push'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
    
    const output = await new Response(proc.stdout).text()
    expect(output).toContain('Provisioning Beads remote')
    expect(output).not.toContain('Will push to remote')
  })
})
```

### 5.3 Alternative: Direct Function Testing

For unit testing CLI handlers without spawning processes:

```typescript
import { describe, it, expect } from 'vitest'

describe('CLI Handlers', () => {
  it('should handle project-beads-remote action', async () => {
    const handler = async (projectId: string) => {
      return { projectId, remote: 'https://doltremoteapi.dolthub.com/...' }
    }
    
    const result = await handler('HVSYN')
    expect(result.projectId).toBe('HVSYN')
    expect(result.remote).toBeDefined()
  })
})
```

---

## 6. END-TO-END SMOKE TEST PATTERN

### 6.1 Integration Test Suite

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApiServer } from '../src/ApiServer'
import { createSyncDatabase } from '../src/database'

describe('E2E: Project API Workflow', () => {
  let app: ReturnType<typeof createApiServer>
  let db: ReturnType<typeof createSyncDatabase>

  beforeAll(() => {
    db = createSyncDatabase(':memory:')
    app = createApiServer({
      db,
      port: 3000,
      // ... other config
    })
  })

  afterAll(() => {
    // Cleanup
  })

  it('should create and retrieve a project', async () => {
    // 1. Create project
    const createRes = await request(app)
      .post('/api/projects')
      .send({
        filesystem_path: '/opt/stacks/test-project',
        name: 'Test Project',
        git_url: 'https://github.com/test/project.git',
      })
      .expect(201)

    const projectId = createRes.body.id

    // 2. Retrieve project
    const getRes = await request(app)
      .get(`/api/projects/${projectId}`)
      .expect(200)

    expect(getRes.body.name).toBe('Test Project')
    expect(getRes.body.id).toBe(projectId)
  })

  it('should handle project workflow with issues', async () => {
    // 1. Create project
    const createRes = await request(app)
      .post('/api/projects')
      .send({
        filesystem_path: '/opt/stacks/test-project-2',
        name: 'Test Project 2',
      })
      .expect(201)

    const projectId = createRes.body.id

    // 2. Get ready work
    const readyRes = await request(app)
      .get(`/api/projects/${projectId}/ready-work`)
      .expect(200)

    expect(readyRes.body).toHaveProperty('work')
    expect(Array.isArray(readyRes.body.work)).toBe(true)
  })

  it('should handle errors gracefully', async () => {
    const res = await request(app)
      .get('/api/projects/nonexistent')
      .expect(404)

    expect(res.body.error).toBeDefined()
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})
```

### 6.2 Running Smoke Tests

```bash
# Run only integration tests
bun run test:integration

# Run only E2E tests
vitest run --grep "E2E:"

# With coverage
vitest run --grep "E2E:" --coverage

# Watch mode for development
vitest --watch --grep "E2E:"
```

---

## 7. REAL-WORLD REFERENCE IMPLEMENTATIONS

### 7.1 Vibesync Test Examples

**Repository**: [Vibesync Tests](../tests/)

**Key Files**:
- `tests/setup.ts` - Global test configuration and utilities
- `tests/unit/` - Unit tests for individual modules
- `tests/integration/` - Integration tests for workflows
- `tests/mocks/` - Mock data and utilities

**Commands**:
```bash
bun run test              # Run all tests
bun run test:watch       # Watch mode
bun run test:coverage    # Coverage report
bun run test:ui          # UI mode
```

### 7.2 Supertest Examples

**Repository**: [Supertest GitHub](https://github.com/visionmedia/supertest)

```typescript
// Basic GET
await request(app)
  .get('/api/projects')
  .expect(200)

// POST with body
await request(app)
  .post('/api/projects')
  .send({ name: 'Test' })
  .expect(201)

// PATCH with conditional
await request(app)
  .patch('/api/projects/123')
  .set('If-Match', 'etag-value')
  .send({ name: 'Updated' })
  .expect(200)

// Error handling
await request(app)
  .get('/api/projects/invalid')
  .expect(404)
  .expect((res) => {
    expect(res.body.error).toBeDefined()
  })
```

---

## 8. SUMMARY TABLE: TESTING PATTERNS

| Pattern | Tool | Use Case | Citation |
|---------|------|----------|----------|
| **Unit Tests** | Vitest | Logic, utilities | [vitest.dev](https://vitest.dev/) |
| **Route Tests** | Supertest | HTTP endpoints | [supertest](https://github.com/visionmedia/supertest) |
| **Error Handling** | Custom middleware | Structured JSON | [speakeasy.com/api-design/errors](https://www.speakeasy.com/api-design/errors) |
| **CLI Testing** | spawn() | Subcommand verification | [bun.sh/docs/api/spawn](https://bun.sh/docs/api/spawn) |
| **Smoke Tests** | describe/it | E2E workflows | [vitest.dev](https://vitest.dev/) |
| **Coverage** | Vitest v8 | Code coverage | [vitest.dev/guide/coverage](https://vitest.dev/guide/coverage) |

---

## 9. QUICK START: VIBESYNC TEST SCAFFOLD

### 9.1 Unit Test Template

```typescript
// tests/unit/MyFeature.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MyFeature } from '../../src/MyFeature'

describe('MyFeature', () => {
  let feature: MyFeature

  beforeEach(() => {
    feature = new MyFeature()
  })

  afterEach(() => {
    // Cleanup
  })

  it('should initialize', () => {
    expect(feature).toBeDefined()
  })

  it('should handle async operations', async () => {
    const result = await feature.doSomething()
    expect(result).toBeDefined()
  })
})
```

### 9.2 API Route Test Template

```typescript
// tests/integration/api.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { createApiServer } from '../../src/ApiServer'

describe('API Routes', () => {
  let app: ReturnType<typeof createApiServer>

  beforeAll(() => {
    app = createApiServer(/* config */)
  })

  it('should GET /api/projects', async () => {
    const res = await request(app)
      .get('/api/projects')
      .expect(200)

    expect(res.body).toHaveProperty('projects')
  })

  it('should POST /api/projects', async () => {
    const res = await request(app)
      .post('/api/projects')
      .send({
        filesystem_path: '/opt/stacks/test',
        name: 'Test',
      })
      .expect(201)

    expect(res.body).toHaveProperty('id')
  })

  it('should handle validation errors', async () => {
    const res = await request(app)
      .post('/api/projects')
      .send({
        name: 'Test',
        // Missing filesystem_path
      })
      .expect(400)

    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})
```

### 9.3 Running Tests

```bash
# Run all tests
bun run test

# Watch mode
bun run test:watch

# Coverage
bun run test:coverage

# Specific file
vitest run tests/unit/MyFeature.test.ts

# UI mode
bun run test:ui
```

---

## REFERENCES

1. **Vitest Documentation**: https://vitest.dev/
2. **Vitest Configuration**: https://vitest.dev/config/
3. **Supertest Documentation**: https://github.com/visionmedia/supertest
4. **Node.js HTTP Module**: https://nodejs.org/api/http.html
5. **REST API Error Design**: https://www.speakeasy.com/api-design/errors
6. **Commander.js**: https://github.com/tj/commander.js
7. **Vibesync Tests**: ../tests/
8. **Vibesync ApiServer**: ../src/ApiServer.ts
9. **Bun Spawn API**: https://bun.sh/docs/api/spawn
10. **Vitest Coverage**: https://vitest.dev/guide/coverage
