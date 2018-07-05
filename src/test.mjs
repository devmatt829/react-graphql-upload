import fs from 'fs'
import stream from 'stream'
import http from 'http'
import t from 'tap'
import Koa from 'koa'
import express from 'express'
import fetch from 'node-fetch'
import FormData from 'form-data'
import {
  apolloUploadKoa,
  apolloUploadExpress,
  MaxFileSizeUploadError,
  MaxFilesUploadError,
  MapBeforeOperationsUploadError,
  FilesBeforeMapUploadError,
  FileMissingUploadError,
  UploadPromiseDisconnectUploadError,
  FileStreamDisconnectUploadError
} from '.'

// This addresses an issue with older versions of node, which cause a non-
// zero exit code if output is truncated. This is something that should be
// addressed in userland, not the library itself.
//
// https://github.com/SheetJS/node-exit-on-epipe

import 'exit-on-epipe'

// GraphQL multipart request spec:
// https://github.com/jaydenseric/graphql-multipart-request-spec

const TEST_FILE_PATH_JSON = 'package.json'
const TEST_FILE_PATH_SVG = 'apollo-upload-logo.svg'

// The max TCP packet size is 64KB, so this file is guaranteed to arrive
// in multiple chunks. It is a public domain image retreived from:
// https://commons.wikimedia.org/wiki/File:Belvedere_Apollo_Pio-Clementino_Inv1015.jpg
const TEST_FILE_PATH_JPG = 'Belvedere_Apollo_Pio-Clementino_Inv1015.jpg'

const startServer = (t, app) =>
  new Promise((resolve, reject) => {
    app.listen(undefined, 'localhost', function(error) {
      if (error) reject(error)
      else {
        t.tearDown(() => this.close())
        resolve(this.address().port)
      }
    })
  })

const uploadTest = upload => async t => {
  const resolved = await upload
  t.type(resolved.stream, 'Capacitor', 'Stream.')
  t.equals(resolved.filename, 'package.json', 'Filename.')
  t.equals(resolved.mimetype, 'application/json', 'MIME type.')
  t.equals(resolved.encoding, '7bit', 'Encoding.')
  await new Promise((resolve, reject) => {
    resolved.stream.on('end', resolve).on('error', reject)

    // Resume and discard the stream. Otherwise busboy hangs, there is no
    // response and the connection eventually resets.
    resolved.stream.resume()
  })
  return resolved
}

t.test('Single file.', async t => {
  t.jobs = 2

  const testRequest = async port => {
    const body = new FormData()

    body.append(
      'operations',
      JSON.stringify({
        variables: {
          file: null
        }
      })
    )

    body.append('map', JSON.stringify({ 1: ['variables.file'] }))
    body.append(1, fs.createReadStream(TEST_FILE_PATH_JSON))

    await fetch(`http://localhost:${port}`, { method: 'POST', body })
  }

  await t.test('Koa middleware.', async t => {
    t.plan(1)

    const app = new Koa().use(apolloUploadKoa()).use(async (ctx, next) => {
      await t.test(
        'Upload resolves.',
        uploadTest(ctx.request.body.variables.file)
      )

      ctx.status = 204
      await next()
    })

    const port = await startServer(t, app)

    await testRequest(port)
  })

  await t.test('Express middleware.', async t => {
    t.plan(1)

    const app = express()
      .use(apolloUploadExpress())
      .use((request, response, next) => {
        t.test('Upload resolves.', uploadTest(request.body.variables.file))
          .then(() => next())
          .catch(next)
      })

    const port = await startServer(t, app)

    await testRequest(port)
  })
})

t.test('Handles unconsumed uploads.', async t => {
  t.jobs = 2

  const testRequest = async port => {
    const body = new FormData()

    body.append(
      'operations',
      JSON.stringify({
        variables: {
          file1: null,
          file2: null
        }
      })
    )

    body.append(
      'map',
      JSON.stringify({
        1: ['variables.file1'],
        2: ['variables.file2']
      })
    )
    body.append(1, fs.createReadStream(TEST_FILE_PATH_JPG))
    body.append(2, fs.createReadStream(TEST_FILE_PATH_JSON))

    await fetch(`http://localhost:${port}`, { method: 'POST', body })
  }

  await t.test('Koa middleware.', async t => {
    t.plan(2)

    const app = new Koa().use(apolloUploadKoa()).use(async (ctx, next) => {
      await t.test('Upload 1 does not need to be consumed.', t => {
        t.ok(ctx.request.body.variables.file1)
        return Promise.resolve()
      })

      await t.test(
        'Upload 2 resolves.',
        uploadTest(ctx.request.body.variables.file2)
      )

      ctx.status = 204
      await next()
    })

    const port = await startServer(t, app)

    await Promise.race([
      testRequest(port),
      new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new Error('The request did not complete.'))
        }, 500)
      })
    ])
  })

  await t.test('Express middleware.', async t => {
    t.plan(2)

    const app = express()
      .use(apolloUploadExpress())
      .use((request, response, next) => {
        t.test('Upload 1 does not need to be consumed.', t => {
          t.ok(request.body.variables.file1)
          return Promise.resolve()
        })
          .then(() =>
            t.test(
              'Upload 2 resolves.',
              uploadTest(request.body.variables.file2)
            )
          )
          .then(() => next())
          .catch(next)
      })

    const port = await startServer(t, app)

    await Promise.race([
      testRequest(port),
      new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new Error('The request did not complete.'))
        }, 500)
      })
    ])
  })
})

t.test('Aborted request.', async t => {
  t.jobs = 1

  const abortedStreamTest = upload => async () => {
    const resolved = await upload

    await new Promise((resolve, reject) => {
      resolved.stream.on('error', err => {
        t.type(err, FileStreamDisconnectUploadError)
        resolve()
      })
      resolved.stream.on('end', reject)
    })

    return resolved
  }

  const abortedPromiseTest = upload => t => {
    t.rejects(upload, UploadPromiseDisconnectUploadError)
    return Promise.resolve()
  }

  const testRequest = port =>
    new Promise((resolve, reject) => {
      const body = new FormData()

      body.append(
        'operations',
        JSON.stringify({
          variables: {
            file1: null,
            file2: null,
            file3: null
          }
        })
      )

      body.append(
        'map',
        JSON.stringify({
          1: ['variables.file1'],
          2: ['variables.file2'],
          3: ['variables.file3']
        })
      )
      body.append(1, fs.createReadStream(TEST_FILE_PATH_JSON))
      body.append(2, fs.createReadStream(TEST_FILE_PATH_SVG))
      body.append(3, fs.createReadStream(TEST_FILE_PATH_JPG))

      const request = http.request({
        method: 'POST',
        host: 'localhost',
        port: port,
        headers: body.getHeaders()
      })

      // This is expected, since we're aborting the connection
      request.on('error', err => {
        if (err.code !== 'ECONNRESET') reject(err)
      })

      // Note that this may emit before the downstream middleware has
      // been processed.
      request.on('close', resolve)

      let data = ''
      const transform = new stream.Transform({
        transform(chunk, encoding, callback) {
          if (this._aborted) return

          const chunkString = chunk.toString('utf8')

          // Concatenate the data
          data += chunkString

          // When we encounter the final contents of the SVG, we will
          // abort the request. This ensures that we are testing:
          // 1. successful upload
          // 2. FileStreamDisconnectUploadError
          // 3. UploadPromiseDisconnectUploadError
          if (data.includes('</svg>')) {
            // How much of this chunk do we want to pipe to the request
            // before aborting?
            const length =
              chunkString.length - (data.length - data.indexOf('</svg>'))

            // Abort now.
            if (length < 1) {
              this._aborted = true
              request.abort()
              return
            }

            // Send partial chunk and then abort
            this._aborted = true
            callback(null, chunkString.substr(0, length))
            setImmediate(() => request.abort())
            return
          }

          callback(null, chunk)
        }
      })

      body.pipe(transform).pipe(request)
    })

  await t.test('Koa middleware.', async t => {
    t.plan(3)

    let resume
    const delay = new Promise(resolve => (resume = resolve))
    const app = new Koa().use(apolloUploadKoa()).use(async (ctx, next) => {
      try {
        await Promise.all([
          t.test(
            'Upload resolves.',
            uploadTest(ctx.request.body.variables.file1)
          ),

          t.test(
            'In-progress upload streams are destroyed.',
            abortedStreamTest(ctx.request.body.variables.file2)
          ),

          t.test(
            'Unresolved upload promises are rejected.',
            abortedPromiseTest(ctx.request.body.variables.file3)
          )
        ])
      } finally {
        resume()
      }

      ctx.status = 204
      await next()
    })
    const port = await startServer(t, app)
    await testRequest(port)
    await delay
  })

  await t.test('Koa middleware without stream error handler.', async t => {
    t.plan(2)

    let resume
    const delay = new Promise(resolve => (resume = resolve))
    const app = new Koa().use(apolloUploadKoa()).use(async (ctx, next) => {
      try {
        await Promise.all([
          t.test(
            'Upload resolves.',
            uploadTest(ctx.request.body.variables.file1)
          ),

          t.test(
            'Unresolved upload promises are rejected.',
            abortedPromiseTest(ctx.request.body.variables.file3)
          )
        ])
      } finally {
        resume()
      }

      ctx.status = 204
      await next()
    })

    const port = await startServer(t, app)

    await testRequest(port)
    await delay
  })

  await t.test('Express middleware.', async t => {
    t.plan(3)

    let resume
    const delay = new Promise(resolve => (resume = resolve))
    const app = express()
      .use(apolloUploadExpress())
      .use((request, response, next) => {
        Promise.all([
          t.test('Upload resolves.', uploadTest(request.body.variables.file1)),

          t.test(
            'In-progress upload streams are destroyed.',
            abortedStreamTest(request.body.variables.file2)
          ),

          t.test(
            'Unresolved upload promises are rejected.',
            abortedPromiseTest(request.body.variables.file3)
          )
        ])
          .then(() => {
            resume()
            next()
          })
          .catch(err => {
            resume()
            next(err)
          })
      })

    const port = await startServer(t, app)

    await testRequest(port)
    await delay
  })

  await t.test('Express middleware without stream error handler.', async t => {
    t.plan(2)

    let resume
    const delay = new Promise(resolve => (resume = resolve))
    const app = express()
      .use(apolloUploadExpress())
      .use((request, response, next) => {
        Promise.all([
          t.test('Upload resolves.', uploadTest(request.body.variables.file1)),

          t.test(
            'Unresolved upload promises are rejected.',
            abortedPromiseTest(request.body.variables.file3)
          )
        ])
          .then(() => {
            resume()
            next()
          })
          .catch(err => {
            resume()
            next(err)
          })
      })

    const port = await startServer(t, app)

    await testRequest(port)
    await delay
  })
})

t.test('Deduped files.', async t => {
  t.jobs = 2

  const testRequest = async port => {
    const body = new FormData()

    body.append(
      'operations',
      JSON.stringify({
        variables: {
          files: [null, null]
        }
      })
    )

    body.append(
      'map',
      JSON.stringify({
        1: ['variables.files.0', 'variables.files.1']
      })
    )

    body.append(1, fs.createReadStream(TEST_FILE_PATH_JSON))

    await fetch(`http://localhost:${port}`, { method: 'POST', body })
  }

  await t.test('Koa middleware.', async t => {
    t.plan(2)

    const app = new Koa().use(apolloUploadKoa()).use(async (ctx, next) => {
      await Promise.all([
        t.test(
          'Upload 1 resolves.',
          uploadTest(ctx.request.body.variables.files[0])
        ),
        t.test(
          'Upload 2 resolves.',
          uploadTest(ctx.request.body.variables.files[1])
        )
      ])

      ctx.status = 204
      await next()
    })

    const port = await startServer(t, app)

    await testRequest(port)
  })

  await t.test('Express middleware.', async t => {
    t.plan(2)

    const app = express()
      .use(apolloUploadExpress())
      .use((request, response, next) => {
        Promise.all([
          t.test(
            'Upload 1 resolves.',
            uploadTest(request.body.variables.files[0])
          ),
          t.test(
            'Upload 2 resolves.',
            uploadTest(request.body.variables.files[1])
          )
        ]).then(() => next())
      })

    const port = await startServer(t, app)

    await testRequest(port)
  })
})

t.test('Missing file.', async t => {
  t.jobs = 2

  const testRequest = async port => {
    const body = new FormData()

    body.append(
      'operations',
      JSON.stringify({
        variables: { file: null }
      })
    )

    body.append(
      'map',
      JSON.stringify({
        1: ['variables.file']
      })
    )

    await fetch(`http://localhost:${port}`, { method: 'POST', body })
  }

  await t.test('Koa middleware.', async t => {
    t.plan(1)

    const app = new Koa().use(apolloUploadKoa()).use(async (ctx, next) => {
      await t.rejects(
        ctx.request.body.variables.file,
        FileMissingUploadError,
        'Upload rejects.'
      )
      ctx.status = 204
      await next()
    })

    const port = await startServer(t, app)

    await testRequest(port)
  })

  await t.test('Express middleware.', async t => {
    t.plan(1)

    const app = express()
      .use(apolloUploadExpress())
      .use((request, response, next) => {
        t.rejects(
          request.body.variables.file,
          FileMissingUploadError,
          'Upload rejects.'
        )
          .then(() => next())
          .catch(next)
      })

    const port = await startServer(t, app)

    await testRequest(port)
  })
})

t.test('Extraneous file.', async t => {
  t.jobs = 2

  const testRequest = async port => {
    const body = new FormData()

    body.append(
      'operations',
      JSON.stringify({
        variables: {
          file: null
        }
      })
    )

    body.append(
      'map',
      JSON.stringify({
        1: ['variables.file']
      })
    )

    body.append(1, fs.createReadStream(TEST_FILE_PATH_JSON))
    body.append(2, fs.createReadStream(TEST_FILE_PATH_JSON))

    await fetch(`http://localhost:${port}`, { method: 'POST', body })
  }

  await t.test('Koa middleware.', async t => {
    t.plan(1)

    const app = new Koa().use(apolloUploadKoa()).use(async (ctx, next) => {
      await t.test(
        'Upload resolves.',
        uploadTest(ctx.request.body.variables.file)
      )
      ctx.status = 204
      await next()
    })

    const port = await startServer(t, app)

    await testRequest(port)
  })

  await t.test('Express middleware.', async t => {
    t.plan(1)

    const app = express()
      .use(apolloUploadExpress())
      .use((request, response, next) => {
        t.test('Upload resolves.', uploadTest(request.body.variables.file))
          .then(() => next())
          .catch(next)
      })

    const port = await startServer(t, app)

    await testRequest(port)
  })
})

t.test('Exceed max files.', async t => {
  t.jobs = 2

  const testRequest = async (t, port) => {
    const body = new FormData()

    body.append(
      'operations',
      JSON.stringify({
        variables: {
          files: [null, null]
        }
      })
    )

    body.append(
      'map',
      JSON.stringify({
        1: ['variables.files.0'],
        2: ['variables.files.1']
      })
    )

    body.append(1, fs.createReadStream(TEST_FILE_PATH_JSON))
    body.append(2, fs.createReadStream(TEST_FILE_PATH_JSON))

    const { status } = await fetch(`http://localhost:${port}`, {
      method: 'POST',
      body
    })

    t.equal(status, 413, 'Response status.')
  }

  await t.test('Koa middleware.', async t => {
    t.plan(2)

    const app = new Koa()
      .on('error', error =>
        t.type(error, MaxFilesUploadError, 'Middleware throws.')
      )
      .use(apolloUploadKoa({ maxFiles: 1 }))

    const port = await startServer(t, app)

    await testRequest(t, port)
  })

  await t.test('Express middleware.', async t => {
    t.plan(2)

    const app = express()
      .use(apolloUploadExpress({ maxFiles: 1 }))
      .use((error, request, response, next) => {
        if (response.headersSent) return next(error)

        t.type(error, MaxFilesUploadError, 'Middleware throws.')

        response.send()
      })

    const port = await startServer(t, app)

    await testRequest(t, port)
  })
})

t.test('Exceed max files with extraneous files interspersed.', async t => {
  t.jobs = 2

  const testRequest = async port => {
    const body = new FormData()

    body.append(
      'operations',
      JSON.stringify({
        variables: {
          files: [null, null]
        }
      })
    )

    body.append(
      'map',
      JSON.stringify({
        '1': ['variables.files.0'],
        '2': ['variables.files.1']
      })
    )

    body.append('1', fs.createReadStream(TEST_FILE_PATH_JSON))
    body.append('extraneous', fs.createReadStream(TEST_FILE_PATH_JSON))
    body.append('2', fs.createReadStream(TEST_FILE_PATH_JSON))

    await fetch(`http://localhost:${port}`, { method: 'POST', body })
  }

  await t.test('Koa middleware.', async t => {
    t.plan(2)

    const app = new Koa()
      .use(apolloUploadKoa({ maxFiles: 2 }))
      .use(async (ctx, next) => {
        await Promise.all([
          t.test(
            'Upload 1 resolves.',
            uploadTest(ctx.request.body.variables.files[0])
          ),

          t.rejects(
            ctx.request.body.variables.files[1],
            MaxFilesUploadError,
            'Upload 2 rejects.'
          )
        ])

        ctx.status = 204
        await next()
      })

    const port = await startServer(t, app)

    await testRequest(port)
  })

  await t.test('Express middleware.', async t => {
    t.plan(2)

    const app = express()
      .use(apolloUploadExpress({ maxFiles: 2 }))
      .use((request, response, next) => {
        Promise.all([
          t.test(
            'Upload 1 resolves.',
            uploadTest(request.body.variables.files[0])
          ),
          t.rejects(
            request.body.variables.files[1],
            MaxFilesUploadError,
            'Upload 2 rejects.'
          )
        ]).then(() => next())
      })

    const port = await startServer(t, app)

    await testRequest(port)
  })
})

t.test('Exceed max file size.', async t => {
  t.jobs = 2

  const testRequest = async port => {
    const body = new FormData()

    body.append(
      'operations',
      JSON.stringify({
        variables: {
          file: null
        }
      })
    )

    body.append('map', JSON.stringify({ '1': ['variables.file'] }))
    body.append('1', fs.createReadStream(TEST_FILE_PATH_JSON))

    await fetch(`http://localhost:${port}`, { method: 'POST', body })
  }

  await t.test('Koa middleware.', async t => {
    t.plan(1)

    const app = new Koa()
      .use(apolloUploadKoa({ maxFileSize: 10 }))
      .use(async (ctx, next) => {
        await t.test('Upload resolves.', async t => {
          await t.rejects(
            uploadTest(ctx.request.body.variables.file)(t),
            MaxFileSizeUploadError,
            'Upload file stream emits error.'
          )
        })

        ctx.status = 204
        await next()
      })

    const port = await startServer(t, app)

    await testRequest(port)
  })

  await t.test('Express middleware.', async t => {
    t.plan(1)

    const app = express()
      .use(apolloUploadExpress({ maxFileSize: 10 }))
      .use((request, response, next) => {
        t.test('Upload resolves.', async t => {
          await t.rejects(
            uploadTest(request.body.variables.file)(t),
            MaxFileSizeUploadError,
            'Upload file stream emits error.'
          )
        })
          .then(() => next())
          .catch(next)
      })

    const port = await startServer(t, app)

    await testRequest(port)
  })
})

t.test('Misorder “map” before “operations”.', async t => {
  t.jobs = 2

  const testRequest = async (t, port) => {
    const body = new FormData()

    body.append(
      'map',
      JSON.stringify({
        '1': ['variables.file']
      })
    )

    body.append(
      'operations',
      JSON.stringify({
        variables: {
          file: null
        }
      })
    )

    body.append('1', fs.createReadStream(TEST_FILE_PATH_JSON))

    const { status } = await fetch(`http://localhost:${port}`, {
      method: 'POST',
      body
    })

    t.equal(status, 400, 'Response status.')
  }

  await t.test('Koa middleware.', async t => {
    t.plan(2)

    const app = new Koa()
      .on('error', error =>
        t.type(error, MapBeforeOperationsUploadError, 'Middleware throws.')
      )
      .use(apolloUploadKoa())

    const port = await startServer(t, app)

    await testRequest(t, port)
  })

  await t.test('Express middleware.', async t => {
    t.plan(2)

    const app = express()
      .use(apolloUploadExpress({ maxFiles: 1 }))
      .use((error, request, response, next) => {
        if (response.headersSent) return next(error)

        t.type(error, MapBeforeOperationsUploadError, 'Middleware throws.')

        response.send()
      })

    const port = await startServer(t, app)

    await testRequest(t, port)
  })
})

t.test('Misorder files before “map”.', async t => {
  t.jobs = 2

  const testRequest = async (t, port) => {
    const body = new FormData()

    body.append(
      'operations',
      JSON.stringify({
        variables: {
          file: null
        }
      })
    )

    body.append('1', fs.createReadStream(TEST_FILE_PATH_JSON))

    body.append(
      'map',
      JSON.stringify({
        '1': ['variables.file']
      })
    )

    const { status } = await fetch(`http://localhost:${port}`, {
      method: 'POST',
      body
    })

    t.equal(status, 400, 'Response status.')
  }

  await t.test('Koa middleware.', async t => {
    t.plan(2)

    const app = new Koa()
      .on('error', error =>
        t.type(error, FilesBeforeMapUploadError, 'Middleware throws.')
      )
      .use(apolloUploadKoa())

    const port = await startServer(t, app)

    await testRequest(t, port)
  })

  await t.test('Express middleware.', async t => {
    t.plan(2)

    const app = express()
      .use(apolloUploadExpress({ maxFiles: 1 }))
      .use((error, request, response, next) => {
        if (response.headersSent) return next(error)

        t.type(error, FilesBeforeMapUploadError, 'Middleware throws.')

        response.send()
      })

    const port = await startServer(t, app)

    await testRequest(t, port)
  })
})
