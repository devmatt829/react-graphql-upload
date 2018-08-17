![Apollo upload logo](https://cdn.rawgit.com/jaydenseric/apollo-upload-server/6831fef/apollo-upload-logo.svg)

# apollo-upload-server

[![npm version](https://badgen.net/npm/v/apollo-upload-server)](https://npm.im/apollo-upload-server) [![Build status](https://travis-ci.org/jaydenseric/apollo-upload-server.svg?branch=master)](https://travis-ci.org/jaydenseric/apollo-upload-server)

Enhances Node.js GraphQL servers for intuitive file uploads via GraphQL queries or mutations. Use with a [GraphQL multipart request spec client implementation](https://github.com/jaydenseric/graphql-multipart-request-spec#client) such as [apollo-upload-client](https://github.com/jaydenseric/apollo-upload-client).

Exported middleware parses [multipart GraphQL requests](https://github.com/jaydenseric/graphql-multipart-request-spec), setting a [typical GraphQL operation object](https://graphql.org/learn/serving-over-http#post-request) (or array when batching) as the request body for common GraphQL middleware to consume.

## Support

The following environments are known to be compatible, or feature this package built in:

- Node.js v8.5+
  - CJS
  - Native ESM with [`--experimental-modules`](https://nodejs.org/api/esm.html#esm_enabling)
- [Koa](https://koajs.com)
  - [`apollo-server-koa`](https://npm.im/apollo-server-koa) (built in)
  - [`graphql-api-koa`](https://npm.im/graphql-api-koa)
- [Express](https://expressjs.com)
  - [`apollo-server`](https://npm.im/apollo-server) (built in)
  - [`apollo-server-express`](https://npm.im/apollo-server-express) (built in)
  - [`express-graphql`](https://npm.im/express-graphql)
- [hapi](https://hapijs.com)
  - [`apollo-server-hapi`](https://npm.im/apollo-server-hapi) (built in)
- [Micro](https://github.com/zeit/micro)
  - [`apollo-server-micro`](https://npm.im/apollo-server-micro) (built in)

See also [GraphQL multipart request spec server implementations](https://github.com/jaydenseric/graphql-multipart-request-spec#server).

## Setup

Setup is necessary if your environment doesn’t feature this package built in (see **_[Support](#support)_**).

To install [`apollo-upload-server`](https://npm.im/apollo-upload-server) and the [`graphql`](https://npm.im/graphql) peer dependency from [npm](https://npmjs.com) run:

```shell
npm install apollo-upload-server graphql
```

Use the [`apolloUploadKoa`](#function-apollouploadkoa) or [`apolloUploadExpress`](#function-apollouploadexpress) middleware just before GraphQL middleware. Alternatively, use [`processRequest`](#function-processrequest) to create custom middleware.

A schema built with separate SDL and resolvers (e.g. using [`makeExecutableSchema`](https://apollographql.com/docs/graphql-tools/generate-schema#makeExecutableSchema)) requires the [`Upload` scalar](#class-graphqlupload) to be setup.

## Usage

Clients implementing the [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec#client) upload files as [`Upload` scalar](#class-graphqlupload) query or mutation variables. Their resolver values are promises that resolve [file upload details](#type-fileupload) for processing and storage. Files are typically streamed into cloud storage but may also be stored in the filesystem.

Tips:

- Promisify and await file upload streams in resolvers or else the server will send a response back to the client before uploads are done, causing a disconnect.
- Handle promise rejection and stream errors; uploads often disconnect due to network connectivity issues or impatient users.
- Process multiple uploads asynchronously with [`Promise.all`](https://developer.mozilla.org/docs/web/javascript/reference/global_objects/promise/all) or a more flexible solution where an error in one does not reject them all.

See also the [example API and client](https://github.com/jaydenseric/apollo-upload-examples).

## Architecture

The [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec#client) makes it possible to use the same multipart data in multiple places, by either mapping the same data to multiple variables, or by using the same variable multiple times. Because GraphQL resolvers are executed asynchronously, each instance needs its own stream.

Additionally, it's possible that GraphQL resolvers for a particular query will require data in a different order than the query's multipart stream.

For these reasons, apollo-upload-server needs to be able to buffer uploads to the filesystem, and uses the library [fs-capacitor](https://github.com/mike-marcacci/fs-capacitor) coordinate simultaneous reading and writing.

As multipart data streams in, it is parsed by [busboy](https://github.com/mscdex/busboy). When both the `operations` and `map` fields load, instances of GraphQL scalar `Upload` in the `operations` are replaced with promises, and the `operations` is passed down the middleware chain to graphql resolvers.

As soon as an upload's contents begins streaming, its data begins buffering to the filesystem, and its associated promise resolves. GraphQL resolvers can then create new streams from the buffer by calling `createReadStream()`. Once all streams have ended or closed, and server has finished responding to the request, the buffer is destroyed.

This has a few ramifications that should be kept in mind:

- The process must have both read and write access to the directory identified by `os.tmpdir()`.
- For temporary files to be removed in a timely fashon, each stream created with `createReadStream()` MUST be either "end" or "close", meaning that `stream.destroy()` should be called if an incomplete stream is no longer needed.
- Once all GraphQL resolvers resolve, existing streams can continue to be used, but attemts to create new ones using `createReadStream()` will throw an error. In other words, make sure you create all necessary streams _before your resolver returns_.
- All remaining temporary files created by apollo-upload-server will be destroyed when the process exits.

## API

### Table of contents

- [class GraphQLUpload](#class-graphqlupload)
  - [Examples](#examples)
- [function apolloUploadExpress](#function-apollouploadexpress)
  - [Examples](#examples-1)
- [function apolloUploadKoa](#function-apollouploadkoa)
  - [Examples](#examples-2)
- [function processRequest](#function-processrequest)
  - [Examples](#examples-3)
- [type FileUpload](#type-fileupload)
- [type GraphQLOperation](#type-graphqloperation)
  - [See](#see)
- [type UploadOptions](#type-uploadoptions)

### class GraphQLUpload

A GraphQL `Upload` scalar that can be used in a [`GraphQLSchema`](https://graphql.org/graphql-js/type/#graphqlschema). It’s value in resolvers is a promise that resolves [file upload details](#type-fileupload) for processing and storage.

#### Examples

_Setup for a schema built with [`makeExecutableSchema`](https://apollographql.com/docs/graphql-tools/generate-schema#makeExecutableSchema)._

> ```js
> import { makeExecutableSchema } from 'graphql-tools'
> import { GraphQLUpload } from 'apollo-upload-server'
>
> const typeDefs = `
>   scalar Upload
> `
>
> const resolvers = {
>   Upload: GraphQLUpload
> }
>
> export const schema = makeExecutableSchema({ typeDefs, resolvers })
> ```

_A manually constructed schema with an image upload mutation._

> ```js
> import { GraphQLSchema, GraphQLObjectType, GraphQLBoolean } from 'graphql'
> import { GraphQLUpload } from 'apollo-upload-server'
>
> export const schema = new GraphQLSchema({
>   mutation: new GraphQLObjectType({
>     name: 'Mutation',
>     fields: {
>       uploadImage: {
>         description: 'Uploads an image.',
>         type: GraphQLBoolean,
>         args: {
>           image: {
>             description: 'Image file.',
>             type: GraphQLUpload
>           }
>         },
>         async resolve(parent, { image }) {
>           const { filename, mimetype, createReadStream } = await image
>           const stream = createReadStream()
>           // Promisify the stream and store the file, then…
>           return true
>         }
>       }
>     }
>   })
> })
> ```

### function apolloUploadExpress

Creates [Express](https://expressjs.com) middleware that processes GraphQL multipart requests using [`processRequest`](#function-processrequest), ignoring non-multipart requests.

| Parameter | Type                                 | Description             |
| :-------- | :----------------------------------- | :---------------------- |
| `options` | [UploadOptions](#type-uploadoptions) | GraphQL upload options. |

**Returns:** [function](https://mdn.io/function) — Express middleware.

#### Examples

_Basic [`express-graphql`](https://npm.im/express-graphql) setup._

> ```js
> import express from 'express'
> import graphqlHTTP from 'express-graphql'
> import { apolloUploadExpress } from 'apollo-upload-server'
> import schema from './schema'
>
> express()
>   .use(
>     '/graphql',
>     apolloUploadExpress({ maxFileSize: 10000000, maxFiles: 10 }),
>     graphqlHTTP({ schema })
>   )
>   .listen(3000)
> ```

### function apolloUploadKoa

Creates [Koa](https://koajs.com) middleware that processes GraphQL multipart requests using [`processRequest`](#function-processrequest), ignoring non-multipart requests.

| Parameter | Type                                 | Description             |
| :-------- | :----------------------------------- | :---------------------- |
| `options` | [UploadOptions](#type-uploadoptions) | GraphQL upload options. |

**Returns:** [function](https://mdn.io/function) — Koa middleware.

#### Examples

_Basic [`graphql-api-koa`](https://npm.im/graphql-api-koa) setup._

> ```js
> import Koa from 'koa'
> import bodyParser from 'koa-bodyparser'
> import { errorHandler, execute } from 'graphql-api-koa'
> import { apolloUploadKoa } from 'apollo-upload-server'
> import schema from './schema'
>
> new Koa()
>   .use(errorHandler())
>   .use(bodyParser())
>   .use(apolloUploadKoa({ maxFileSize: 10000000, maxFiles: 10 }))
>   .use(execute({ schema }))
>   .listen(3000)
> ```

### function processRequest

Processes a [GraphQL multipart request](https://github.com/jaydenseric/graphql-multipart-request-spec). Used in [`apolloUploadKoa`](#function-apollouploadkoa) and [`apolloUploadExpress`](#function-apollouploadexpress) and can be used to create custom middleware.

| Parameter  | Type                                  | Description                                                                                               |
| :--------- | :------------------------------------ | :-------------------------------------------------------------------------------------------------------- |
| `request`  | IncomingMessage                       | [Node.js HTTP server request instance](https://nodejs.org/api/http.html#http_class_http_incomingmessage). |
| `response` | ServerResponse                        | [Node.js HTTP server response instance](https://nodejs.org/api/http.html#http_class_http_serverresponse). |
| `options`  | [UploadOptions](#type-uploadoptions)? | GraphQL upload options.                                                                                   |

**Returns:** [Promise](https://mdn.io/promise)&lt;[GraphQLOperation](#type-graphqloperation) | [Array](https://mdn.io/array)&lt;[GraphQLOperation](#type-graphqloperation)>> — GraphQL operation or batch of operations for a GraphQL server to consume (usually as the request body).

#### Examples

_How to import._

> ```js
> import { processRequest } from 'apollo-upload-server'
> ```

### type FileUpload

File upload details, resolved from an [`Upload` scalar](#class-graphqlupload) promise.

**Type:** [Object](https://mdn.io/object)

| Property           | Type                                | Description                                                                                                                                                                                                                                |
| :----------------- | :---------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filename`         | [string](https://mdn.io/string)     | File name.                                                                                                                                                                                                                                 |
| `mimetype`         | [string](https://mdn.io/string)     | File MIME type. Provided by the client and can’t be trusted.                                                                                                                                                                               |
| `encoding`         | [string](https://mdn.io/string)     | File stream transfer encoding.                                                                                                                                                                                                             |
| `createReadStream` | [function](https://mdn.io/function) | Returns a Node.js readable stream of the file contents, for processing and storing the file. Multiple calls create independent streams. Throws if called after all resolvers have resolved, or after an error has interrupted the request. |

### type GraphQLOperation

A GraphQL operation object in a shape that can be consumed and executed by most GraphQL servers.

**Type:** [Object](https://mdn.io/object)

| Property        | Type                                     | Description                                          |
| :-------------- | :--------------------------------------- | :--------------------------------------------------- |
| `query`         | [string](https://mdn.io/string)          | GraphQL document containing queries and fragments.   |
| `operationName` | [string](https://mdn.io/string) \| null? | GraphQL document operation name to execute.          |
| `variables`     | [object](https://mdn.io/object) \| null? | GraphQL document operation variables and values map. |

#### See

- [GraphQL over HTTP spec](https://github.com/APIs-guru/graphql-over-http#request-parameters).
- [Apollo Server POST requests](https://www.apollographql.com/docs/apollo-server/requests#postRequests).

### type UploadOptions

GraphQL upload server options, mostly relating to security, performance and limits.

**Type:** [Object](https://mdn.io/object)

| Property       | Type                                          | Description                                                                           |
| :------------- | :-------------------------------------------- | :------------------------------------------------------------------------------------ |
| `maxFieldSize` | [number](https://mdn.io/number)? = `1000000`  | Maximum allowed non-file multipart form field size in bytes; enough for your queries. |
| `maxFileSize`  | [number](https://mdn.io/number)? = `Infinity` | Maximum allowed file size in bytes.                                                   |
| `maxFiles`     | [number](https://mdn.io/number)? = `Infinity` | Maximum allowed number of files.                                                      |
