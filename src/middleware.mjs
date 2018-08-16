import Busboy from 'busboy'
import objectPath from 'object-path'
import WriteStream from 'fs-capacitor'
import {
  SPEC_URL,
  ParseUploadError,
  MaxFileSizeUploadError,
  MaxFilesUploadError,
  MapBeforeOperationsUploadError,
  FilesBeforeMapUploadError,
  FileMissingUploadError,
  DisconnectUploadError
} from './errors'

/**
 * GraphQL upload server options, mostly relating to security, performance and
 * limits.
 * @kind typedef
 * @name UploadOptions
 * @type {object}
 * @prop {number} [maxFieldSize=1000000] Maximum allowed non-file multipart form field size in bytes; enough for your queries.
 * @prop {number} [maxFileSize=Infinity] Maximum allowed file size in bytes.
 * @prop {number} [maxFiles=Infinity] Maximum allowed number of files.
 */

/**
 * A GraphQL operation object in a shape that can be consumed and executed by
 * most GraphQL servers.
 * @kind typedef
 * @name GraphQLOperation
 * @type {object}
 * @prop {string} query GraphQL document containing queries and fragments.
 * @prop {string|null} [operationName] GraphQL document operation name to execute.
 * @prop {object|null} [variables] GraphQL document operation variables and values map.
 * @see [GraphQL over HTTP spec](https://github.com/APIs-guru/graphql-over-http#request-parameters).
 * @see [Apollo Server POST requests](https://www.apollographql.com/docs/apollo-server/requests#postRequests).
 */

/**
 * An expected file upload.
 * @kind class
 * @name Upload
 * @ignore
 */
class Upload {
  // eslint-disable-next-line require-jsdoc
  constructor() {
    /**
     * Promise that resolves file details.
     * @kind member
     * @name Upload#promise
     * @type {Promise<FileUpload>}
     * @ignore
     */
    this.promise = new Promise((resolve, reject) => {
      /**
       * Resolves the upload promise with the file details.
       * @kind function
       * @name Upload#resolve
       * @param {Object} file File details.
       * @ignore
       */
      this.resolve = file => {
        this.file = file
        resolve(file)
      }

      /**
       * Rejects the upload promise with an error.
       * @kind function
       * @name Upload#reject
       * @param {object} error Error instance.
       * @ignore
       */
      this.reject = reject
    })

    // Prevent errors crashing Node.js, see:
    // https://github.com/nodejs/node/issues/20392
    this.promise.catch(() => {})
  }
}

/**
 * Processes a [GraphQL multipart request](https://github.com/jaydenseric/graphql-multipart-request-spec).
 * Used in [`apolloUploadKoa`]{@link apolloUploadKoa} and [`apolloUploadExpress`]{@link apolloUploadExpress}
 * and can be used to create custom middleware.
 * @kind function
 * @name processRequest
 * @param {IncomingMessage} request [Node.js HTTP server request instance](https://nodejs.org/api/http.html#http_class_http_incomingmessage).
 * @param {ServerResponse} response [Node.js HTTP server response instance](https://nodejs.org/api/http.html#http_class_http_serverresponse).
 * @param {UploadOptions} [options] GraphQL upload options.
 * @returns {Promise<GraphQLOperation | Array<GraphQLOperation>>} GraphQL operation or batch of operations for a GraphQL server to consume (usually as the request body).
 * @example <caption>How to import.</caption>
 * ```js
 * import { processRequest } from 'apollo-upload-server'
 * ```
 */
export const processRequest = (
  request,
  response,
  { maxFieldSize, maxFileSize, maxFiles } = {}
) =>
  new Promise((resolve, reject) => {
    let requestEnded = false
    let released = false
    let exitError
    let currentStream
    let operations
    let operationsPath
    let map

    const parser = new Busboy({
      headers: request.headers,
      limits: {
        fieldSize: maxFieldSize,
        fields: 2, // Only operations and map.
        fileSize: maxFileSize,
        files: maxFiles
      }
    })

    /**
     * Exits request processing with an error. Successive calls have no effect.
     * @kind function
     * @name processRequest~exit
     * @param {Object} error Error instance.
     * @ignore
     */
    const exit = error => {
      if (exitError) return
      exitError = error

      reject(exitError)

      parser.destroy()

      if (currentStream) currentStream.destroy(exitError)

      if (map)
        for (const upload of map.values())
          if (!upload.file) upload.reject(exitError)

      request.unpipe(parser)
      request.resume()
    }

    /**
     * Releases resources and cleans up Capacitor temporary files. Successive
     * calls have no effect.
     * @kind function
     * @name processRequest~release
     * @ignore
     */
    const release = () => {
      if (released) return
      released = true

      if (map)
        for (const upload of map.values())
          if (upload.file) upload.file.capacitor.destroy()
    }

    parser.on('field', (fieldName, value) => {
      switch (fieldName) {
        case 'operations':
          try {
            operations = JSON.parse(value)
            operationsPath = objectPath(operations)
          } catch (error) {
            exit(
              new ParseUploadError(
                `Invalid JSON in the ‘operations’ multipart field (${SPEC_URL}).`,
                400
              )
            )
          }
          break
        case 'map': {
          if (!operations)
            return exit(
              new MapBeforeOperationsUploadError(
                `Misordered multipart fields; ‘map’ should follow ‘operations’ (${SPEC_URL}).`,
                400
              )
            )

          let mapEntries
          try {
            mapEntries = Object.entries(JSON.parse(value))
          } catch (error) {
            return exit(
              new ParseUploadError(
                `Invalid JSON in the ‘map’ multipart field (${SPEC_URL}).`,
                400
              )
            )
          }

          // Check max files is not exceeded, even though the number of files to
          // parse might not match the map provided by the client.
          if (mapEntries.length > maxFiles)
            return exit(
              new MaxFilesUploadError(
                `${maxFiles} max file uploads exceeded.`,
                413
              )
            )

          map = new Map()
          for (const [fieldName, paths] of mapEntries) {
            map.set(fieldName, new Upload())

            for (const path of paths)
              operationsPath.set(path, map.get(fieldName).promise)
          }

          resolve(operations)
        }
      }
    })

    parser.on('file', (fieldName, stream, filename, encoding, mimetype) => {
      if (!map) {
        // Prevent an unhandled error from crashing the process.
        stream.on('error', () => {})
        stream.resume()

        return exit(
          new FilesBeforeMapUploadError(
            `Misordered multipart fields; files should follow ‘map’ (${SPEC_URL}).`,
            400
          )
        )
      }

      currentStream = stream
      stream.on('end', () => {
        if (currentStream === stream) currentStream = null
      })

      const upload = map.get(fieldName)
      if (upload) {
        const capacitor = new WriteStream()

        capacitor.on('error', () => {
          stream.unpipe()
          stream.resume()
        })

        stream.on('limit', () => {
          if (currentStream === stream) currentStream = null
          stream.unpipe()
          capacitor.destroy(
            new MaxFileSizeUploadError(
              'File truncated as it exceeds the size limit.',
              413
            )
          )
        })

        stream.on('error', error => {
          if (currentStream === stream) currentStream = null

          stream.unpipe()
          capacitor.destroy(exitError || error)
        })

        stream.pipe(capacitor)

        upload.resolve(
          Object.create(null, {
            filename: { value: filename, enumerable: true },
            mimetype: { value: mimetype, enumerable: true },
            encoding: { value: encoding, enumerable: true },
            createReadStream: {
              value() {
                const error = capacitor.error || (released ? exitError : null)
                if (error) throw error

                return capacitor.createReadStream()
              },
              enumerable: true
            },
            capacitor: { value: capacitor }
          })
        )
      } else {
        // Discard the unexpected file.
        stream.on('error', () => {})
        stream.resume()
      }
    })

    parser.once('filesLimit', () =>
      exit(
        new MaxFilesUploadError(`${maxFiles} max file uploads exceeded.`, 413)
      )
    )

    parser.once('finish', () => {
      request.unpipe(parser)
      request.resume()

      if (map)
        for (const upload of map.values())
          if (!upload.file)
            upload.reject(
              new FileMissingUploadError('File missing in the request.', 400)
            )
    })

    parser.once('error', exit)

    response.once('finish', release)
    response.once('close', release)

    request.once('end', () => {
      requestEnded = true
    })

    request.once('close', () => {
      if (!requestEnded)
        exit(
          new DisconnectUploadError(
            'Request disconnected during file upload stream parsing.'
          )
        )
    })

    request.pipe(parser)
  })

/**
 * Creates [Koa](https://koajs.com) middleware that processes GraphQL multipart
 * requests using [`processRequest`]{@link processRequest}, ignoring
 * non-multipart requests.
 * @kind function
 * @name apolloUploadKoa
 * @param {UploadOptions} options GraphQL upload options.
 * @returns {function} Koa middleware.
 * @example <caption>Basic [`graphql-api-koa`](https://npm.im/graphql-api-koa) setup.</caption>
 * ```js
 * import Koa from 'koa'
 * import bodyParser from 'koa-bodyparser'
 * import { errorHandler, execute } from 'graphql-api-koa'
 * import { apolloUploadKoa } from 'apollo-upload-server'
 * import schema from './schema'
 *
 * new Koa()
 *   .use(errorHandler())
 *   .use(bodyParser())
 *   .use(apolloUploadKoa({ maxFileSize: 10000000, maxFiles: 10 }))
 *   .use(execute({ schema }))
 *   .listen(3000)
 * ```
 */
export const apolloUploadKoa = options => async (ctx, next) => {
  if (!ctx.request.is('multipart/form-data')) return next()

  const finished = new Promise(resolve => ctx.req.on('end', resolve))

  try {
    ctx.request.body = await processRequest(ctx.req, ctx.res, options)
    await next()
  } finally {
    await finished
  }
}

/**
 * Creates [Express](https://expressjs.com) middleware that processes GraphQL
 * multipart requests using [`processRequest`]{@link processRequest}, ignoring
 * non-multipart requests.
 * @kind function
 * @name apolloUploadExpress
 * @param {UploadOptions} options GraphQL upload options.
 * @returns {function} Express middleware.
 * @example <caption>Basic [`express-graphql`](https://npm.im/express-graphql) setup.</caption>
 * ```js
 * import express from 'express'
 * import graphqlHTTP from 'express-graphql'
 * import { apolloUploadExpress } from 'apollo-upload-server'
 * import schema from './schema'
 *
 * express()
 *   .use(
 *     '/graphql',
 *     apolloUploadExpress({ maxFileSize: 10000000, maxFiles: 10 }),
 *     graphqlHTTP({ schema })
 *   )
 *   .listen(3000)
 * ```
 */
export const apolloUploadExpress = options => (request, response, next) => {
  if (!request.is('multipart/form-data')) return next()

  const finished = new Promise(resolve => request.on('end', resolve))

  const { send } = response
  response.send = (...args) => {
    finished.then(() => {
      response.send = send
      response.send(...args)
    })
  }

  processRequest(request, response, options)
    .then(body => {
      request.body = body
      next()
    })
    .catch(error => {
      if (error.status && error.expose) response.status(error.status)
      next(error)
    })
}
