import * as fs from 'fs'
import * as tmp from 'tmp-promise'
import * as stream from 'stream'
import {
  ArtifactResponse,
  CreateArtifactParameters,
  PatchArtifactSize,
  UploadResults
} from './contracts'
import {
  getArtifactUrl,
  getContentRange,
  getRequestOptions,
  isRetryableStatusCode,
  isSuccessStatusCode,
  createHttpClient
} from './utils'
import {
  getUploadChunkSize,
  getUploadFileConcurrency,
  getUploadRetryCount,
  getRetryWaitTimeInMilliseconds
} from './config-variables'
import {createGZipFileOnDisk, createGZipFileInBuffer} from './upload-gzip'
import {URL} from 'url'
import {performance} from 'perf_hooks'
import {UploadStatusReporter} from './upload-status-reporter'
import {debug, warning, info} from '@actions/core'
import {HttpClientResponse} from '@actions/http-client/index'
import {IHttpClientResponse} from '@actions/http-client/interfaces'
import {HttpManager} from './http-manager'
import {UploadSpecification} from './upload-specification'
import {UploadOptions} from './upload-options'

export class UploadHttpClient {
  private uploadHttpManager: HttpManager
  private statusReporter: UploadStatusReporter

  constructor() {
    this.uploadHttpManager = new HttpManager()
    this.statusReporter = new UploadStatusReporter()
  }

  /**
   * Creates a file container for the new artifact in the remote blob storage/file service
   * @param {string} artifactName Name of the artifact being created
   * @returns The response from the Artifact Service if the file container was successfully created
   */
  async createArtifactInFileContainer(
    artifactName: string
  ): Promise<ArtifactResponse> {
    const parameters: CreateArtifactParameters = {
      Type: 'actions_storage',
      Name: artifactName
    }
    const data: string = JSON.stringify(parameters, null, 2)
    const artifactUrl = getArtifactUrl()

    // no concurrent calls so a single httpClient without the http-manager is sufficient
    const client = createHttpClient()

    // no keep-alive header, so client disposal is not necessary
    const requestOptions = getRequestOptions('application/json', false, false)
    const rawResponse = await client.post(artifactUrl, data, requestOptions)
    const body: string = await rawResponse.readBody()

    if (isSuccessStatusCode(rawResponse.message.statusCode) && body) {
      return JSON.parse(body)
    } else {
      // eslint-disable-next-line no-console
      console.log(rawResponse)
      throw new Error(
        `Unable to create a container for the artifact ${artifactName}`
      )
    }
  }

  /**
   * Concurrently upload all of the files in chunks
   * @param {string} uploadUrl Base Url for the artifact that was created
   * @param {SearchResult[]} filesToUpload A list of information about the files being uploaded
   * @returns The size of all the files uploaded in bytes
   */
  async uploadArtifactToFileContainer(
    uploadUrl: string,
    filesToUpload: UploadSpecification[],
    options?: UploadOptions
  ): Promise<UploadResults> {
    const FILE_CONCURRENCY = getUploadFileConcurrency()
    const MAX_CHUNK_SIZE = getUploadChunkSize()
    debug(
      `File Concurrency: ${FILE_CONCURRENCY}, and Chunk Size: ${MAX_CHUNK_SIZE}`
    )

    const parameters: UploadFileParameters[] = []

    // by default, file uploads will continue if there is an error unless specified differently in the options
    let continueOnError = true
    if (options) {
      if (options.continueOnError === false) {
        continueOnError = false
      }
    }

    // prepare the necessary parameters to upload all the files
    for (const file of filesToUpload) {
      const resourceUrl = new URL(uploadUrl)
      resourceUrl.searchParams.append('itemPath', file.uploadFilePath)
      parameters.push({
        file: file.absoluteFilePath,
        resourceUrl: resourceUrl.toString(),
        maxChunkSize: MAX_CHUNK_SIZE,
        continueOnError
      })
    }

    const parallelUploads = [...new Array(FILE_CONCURRENCY).keys()]
    // each parallel upload gets its own http client
    this.uploadHttpManager.createClients(FILE_CONCURRENCY)
    const failedItemsToReport: string[] = []
    let currentFile = 0
    let completedFiles = 0
    let uploadFileSize = 0
    let totalFileSize = 0
    let abortPendingFileUploads = false

    this.statusReporter.setTotalNumberOfFilesToUpload(filesToUpload.length)
    this.statusReporter.startDisplayingStatus()

    // only allow a certain amount of files to be uploaded at once, this is done to reduce potential errors
    await Promise.all(
      parallelUploads.map(async index => {
        while (currentFile < filesToUpload.length) {
          const currentFileParameters = parameters[currentFile]
          currentFile += 1
          if (abortPendingFileUploads) {
            failedItemsToReport.push(currentFileParameters.file)
            continue
          }

          const startTime = performance.now()
          const uploadFileResult = await this.uploadFileAsync(
            index,
            currentFileParameters
          )

          debug(
            `File: ${++completedFiles}/${filesToUpload.length}. ${
              currentFileParameters.file
            } took ${(performance.now() - startTime).toFixed(
              3
            )} milliseconds to finish upload`
          )
          uploadFileSize += uploadFileResult.successfullUploadSize
          totalFileSize += uploadFileResult.totalSize
          if (uploadFileResult.isSuccess === false) {
            failedItemsToReport.push(currentFileParameters.file)
            if (!continueOnError) {
              // existing uploads will be able to finish however all pending uploads will fail fast
              abortPendingFileUploads = true
            }
          }
          this.statusReporter.incrementProcessedCount()
        }
      })
    )

    this.statusReporter.stopDisplayingStatus()

    // done uploading, safety dispose all connections
    this.uploadHttpManager.disposeAllConnections()

    info(`Total size of all the files uploaded is ${uploadFileSize} bytes`)
    return {
      uploadSize: uploadFileSize,
      totalSize: totalFileSize,
      failedItems: failedItemsToReport
    }
  }

  /**
   * Asynchronously uploads a file. The file is compressed and uploaded using GZip if it is determined to save space.
   * If the upload file is bigger than the max chunk size it will be uploaded via multiple calls
   * @param {number} httpClientIndex The index of the httpClient that is being used to make all of the calls
   * @param {UploadFileParameters} parameters Information about the file that needs to be uploaded
   * @returns The size of the file that was uploaded in bytes along with any failed uploads
   */
  private async uploadFileAsync(
    httpClientIndex: number,
    parameters: UploadFileParameters
  ): Promise<UploadFileResult> {
    const totalFileSize: number = fs.statSync(parameters.file).size
    let offset = 0
    let isUploadSuccessful = true
    let failedChunkSizes = 0
    let abortFileUpload = false
    let uploadFileSize = 0
    let isGzip = true

    // file is less than 64k in size, to increase thoroughput and minimize disk I/O for creating a new GZip file, an in-memory buffer is used
    if (totalFileSize < 65536) {
      const buffer = await createGZipFileInBuffer(parameters.file)
      let uploadStream: NodeJS.ReadableStream

      if (totalFileSize < buffer.byteLength) {
        // compression did not help with reducing the size, use a readable stream from the original file for upload
        uploadStream = fs.createReadStream(parameters.file)
        isGzip = false
        uploadFileSize = totalFileSize
      } else {
        // create a readable stream using a PassThrough stream and the in-memory buffer. A PassThrought stream is both a readable stream and writable stream
        const passThrough = new stream.PassThrough()
        passThrough.end(buffer)
        uploadStream = passThrough
        uploadFileSize = buffer.byteLength
      }

      // the entire file should be uploaded with a single call
      if (uploadFileSize > parameters.maxChunkSize) {
        throw new Error('Chunk size is too large to upload with a single call')
      }

      const result = await this.uploadChunk(
        httpClientIndex,
        parameters.resourceUrl,
        uploadStream,
        0,
        uploadFileSize - 1,
        uploadFileSize,
        isGzip,
        totalFileSize
      )

      if (!result) {
        // Chunk failed to upload
        isUploadSuccessful = false
        failedChunkSizes += uploadFileSize
        warning(`Aborting upload for ${parameters.file} due to failure`)
      }

      return {
        isSuccess: isUploadSuccessful,
        successfullUploadSize: uploadFileSize - failedChunkSizes,
        totalSize: totalFileSize
      }
    } else {
      // using npm tmp-promise to help create a temporary file that can be used for compression
      return tmp
        .file()
        .then(async temporary => {
          // create a GZip file of the original file being uploaded, the original file should not be modified in any way
          uploadFileSize = await createGZipFileOnDisk(
            parameters.file,
            temporary.path
          )
          let uploadFilePath = temporary.path

          if (totalFileSize < uploadFileSize) {
            // compression did not help with reducing the size, use the original file for upload
            uploadFileSize = totalFileSize
            uploadFilePath = parameters.file
            isGzip = false

            // immediatly delete the temporary GZip file that was created
            temporary.cleanup()
          }

          // upload only a single chunk at a time
          while (offset < uploadFileSize) {
            const chunkSize = Math.min(
              uploadFileSize - offset,
              parameters.maxChunkSize
            )
            if (abortFileUpload) {
              // if we don't want to continue in the event of an error, any pending upload chunks will be marked as failed
              failedChunkSizes += chunkSize
              continue
            }

            // if an individual file is greater than 100MB (1024*1024*100) in size, display extra information about the upload status
            if (uploadFileSize > 104857600) {
              this.statusReporter.updateLargeFileStatus(
                parameters.file,
                offset,
                uploadFileSize
              )
            }

            const start = offset
            const end = offset + chunkSize - 1
            offset += parameters.maxChunkSize

            const chunk = fs.createReadStream(uploadFilePath, {
              start,
              end,
              autoClose: false
            })

            const result = await this.uploadChunk(
              httpClientIndex,
              parameters.resourceUrl,
              chunk,
              start,
              end,
              uploadFileSize,
              isGzip,
              totalFileSize
            )

            if (!result) {
              /**
               * Chunk failed to upload, report as failed and do not continue uploading any more chunks for the file. It is possible that part of a chunk was
               * successfully uploaded so the server may report a different size for what was uploaded
               **/
              isUploadSuccessful = false
              failedChunkSizes += chunkSize
              warning(`Aborting upload for ${parameters.file} due to failure`)
              abortFileUpload = true
            }
          }
        })
        .then(
          async (): Promise<UploadFileResult> => {
            // after the file upload is complete and the temporary file is deleted, return the UploadResult
            return new Promise(resolve => {
              resolve({
                isSuccess: isUploadSuccessful,
                successfullUploadSize: uploadFileSize - failedChunkSizes,
                totalSize: totalFileSize
              })
            })
          }
        )
    }
  }

  /**
   * Uploads a chunk of an individual file to the specified resourceUrl. If the upload fails and the status code
   * indicates a retryable status, we try to upload the chunk as well
   * @param {number} httpClientIndex The index of the httpClient being used to make all the necessary calls
   * @param {string} resourceUrl Url of the resource that the chunk will be uploaded to
   * @param {NodeJS.ReadableStream} data Stream of the file that will be uploaded
   * @param {number} start Starting byte index of file that the chunk belongs to
   * @param {number} end Ending byte index of file that the chunk belongs to
   * @param {number} totalSize Total size of the file in bytes that is being uploaded
   * @param {boolean} isGzip Denotes if we are uploading a Gzip compressed stream
   * @param {number} uncompressedSize Original size of the file that is being uploaded
   * @returns if the chunk was successfully uploaded
   */
  private async uploadChunk(
    httpClientIndex: number,
    resourceUrl: string,
    data: NodeJS.ReadableStream,
    start: number,
    end: number,
    totalSize: number,
    isGzip: boolean,
    uncompressedSize: number
  ): Promise<boolean> {
    // prepare all the necessary headers before making any http call
    const requestOptions = getRequestOptions(
      'application/octet-stream',
      true,
      isGzip,
      uncompressedSize,
      end - start + 1,
      getContentRange(start, end, totalSize)
    )

    const uploadChunkRequest = async (): Promise<IHttpClientResponse> => {
      return await this.uploadHttpManager
        .getClient(httpClientIndex)
        .sendStream('PUT', resourceUrl, data, requestOptions)
    }

    let retryCount = 0
    const retryLimit = getUploadRetryCount()

    // allow for failed chunks to be retried multiple times
    while (retryCount <= retryLimit) {
      try {
        const response = await uploadChunkRequest()
        // read the body to properly drain the response before possibly reusing the connection
        await response.readBody()

        if (isSuccessStatusCode(response.message.statusCode)) {
          return true
        } else if (isRetryableStatusCode(response.message.statusCode)) {
          // dispose the existing connection and create a new one
          this.uploadHttpManager.disposeClient(httpClientIndex)
          retryCount++
          if (retryCount > retryLimit) {
            info(
              `Retry limit has been reached for chunk at offset ${start} to ${resourceUrl}`
            )
            return false
          } else {
            info(
              `HTTP ${response.message.statusCode} during chunk upload, will retry at offset ${start} after ${getRetryWaitTimeInMilliseconds} milliseconds. Retry count #${retryCount}. URL ${resourceUrl}`
            )
            await new Promise(resolve =>
              setTimeout(resolve, getRetryWaitTimeInMilliseconds())
            )
            this.uploadHttpManager.replaceClient(httpClientIndex)
          }
        } else {
          info(`#ERROR# Unable to upload chunk to ${resourceUrl}`)
          // eslint-disable-next-line no-console
          console.log(response)
          return false
        }
      } catch (error) {
        // if an error is thrown, it is most likely due to a timeout, dispose of the connection, wait and retry with a new connection
        this.uploadHttpManager.disposeClient(httpClientIndex)

        // eslint-disable-next-line no-console
        console.log(error)

        retryCount++
        if (retryCount > retryLimit) {
          info(
            `Retry limit has been reached for chunk at offset ${start} to ${resourceUrl}`
          )
          return false
        } else {
          info(`Retrying chunk upload after encountering an error`)
          await new Promise(resolve =>
            setTimeout(resolve, getRetryWaitTimeInMilliseconds())
          )
          this.uploadHttpManager.replaceClient(httpClientIndex)
        }
      }
    }
    return false
  }

  /**
   * Updates the size of the artifact from -1 which was initially set when the container was first created for the artifact.
   * Updating the size indicates that we are done uploading all the contents of the artifact
   */
  async patchArtifactSize(size: number, artifactName: string): Promise<void> {
    // no concurrent calls so a single httpClient without the http-manager is sufficient
    const client = createHttpClient()
    // no keep-alive header so no client disposal is necessary
    const requestOptions = getRequestOptions('application/json', false, false)

    const resourceUrl = new URL(getArtifactUrl())
    resourceUrl.searchParams.append('artifactName', artifactName)

    const parameters: PatchArtifactSize = {Size: size}
    const data: string = JSON.stringify(parameters, null, 2)
    debug(`URL is ${resourceUrl.toString()}`)

    const rawResponse: HttpClientResponse = await client.patch(
      resourceUrl.toString(),
      data,
      requestOptions
    )
    const body: string = await rawResponse.readBody()

    if (isSuccessStatusCode(rawResponse.message.statusCode)) {
      debug(
        `Artifact ${artifactName} has been successfully uploaded, total size ${size}`
      )
    } else if (rawResponse.message.statusCode === 404) {
      throw new Error(`An Artifact with the name ${artifactName} was not found`)
    } else {
      // eslint-disable-next-line no-console
      console.log(body)
      throw new Error(`Unable to finish uploading artifact ${artifactName}`)
    }
  }
}

interface UploadFileParameters {
  file: string
  resourceUrl: string
  maxChunkSize: number
  continueOnError: boolean
}

interface UploadFileResult {
  isSuccess: boolean
  successfullUploadSize: number
  totalSize: number
}