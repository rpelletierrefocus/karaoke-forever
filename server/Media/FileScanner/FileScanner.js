const path = require('path')
const debug = require('debug')
const log = debug('app:media:fileScanner')
const { promisify } = require('util')
const fs = require('fs')
const stat = promisify(fs.stat)
const musicMeta = require('music-metadata')
const mp4info = require('../../lib/mp4info.js')
const getFiles = require('./getFiles')
const getPerms = require('../../lib/getPermutations')
const Scanner = require('../Scanner')
const Media = require('../Media')
const MetaParser = require('../MetaParser')

const videoExts = ['.cdg', '.mp4'].reduce((perms, ext) => perms.concat(getPerms(ext)), [])
const audioTypes = ['m4a', 'mp3']

class FileScanner extends Scanner {
  constructor (prefs) {
    super()
    this.paths = prefs.paths
    this.lastDir = ''
  }

  async scan () {
    const offlinePaths = [] // pathIds
    const validMedia = [] // mediaIds
    let files = []

    // count files to scan from all paths
    for (let i = 0; i < this.paths.result.length; i++) {
      const pathId = this.paths.result[i]

      this.emitStatus(`Listing folders (${i + 1} of ${this.paths.result.length})`, 0)

      try {
        log('Searching path: %s', this.paths.entities[pathId].path)
        let list = await getFiles(this.paths.entities[pathId].path)
        list = list.filter(file => videoExts.includes(path.extname(file)))

        log('  => found %s files with valid extensions (cdg, mp4)', list.length)
        files = files.concat(list)
      } catch (err) {
        log(`  => ${err.message} (path offline)`)
        offlinePaths.push(pathId)
      }

      if (this.isCanceling) {
        return
      }
    } // end for

    log('Processing %s total files', files.length)

    // process files
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const curDir = path.parse(file).dir
      const pathId = this.paths.result.find(pathId =>
        file.indexOf(this.paths.entities[pathId].path) === 0
      )

      // (re)init parser with this folder's config, if any
      if (this.lastDir !== curDir) {
        this.lastDir = curDir
        const cfg = await getCfg(path.normalize(path.dirname(file)), path.normalize(this.paths.entities[pathId].path))
        this.parser = MetaParser(cfg)
      }

      // emit progress
      log('[%s/%s] %s', i + 1, files.length, file)
      this.emitStatus(`Scanning media (${i + 1} of ${files.length})`, ((i + 1) / files.length) * 100)

      try {
        const mediaId = await this.processFile({ file, pathId })

        // successfuly processed
        validMedia.push(mediaId)
      } catch (err) {
        log(err)
        // try the next file
      }

      if (this.isCanceling) {
        return
      }
    } // end for

    // cleanup
    log('Looking for orphaned media entries')

    {
      const invalidMedia = []
      const res = await Media.search()

      res.result.forEach(mediaId => {
        // was this media item just verified?
        if (validMedia.includes(mediaId)) {
          return
        }

        // is media item in an offline path?
        if (offlinePaths.includes(res.entities[mediaId].pathId)) {
          return
        }

        // looks like we need to remove it
        invalidMedia.push(mediaId)
        log(`  => ${res.entities[mediaId].file}`)
      })

      log(`Found ${invalidMedia.length} orphaned media entries`)

      if (invalidMedia.length) {
        await Media.remove(invalidMedia)
      }
    }
  }

  async processFile ({ file, pathId }) {
    const basePath = this.paths.entities[pathId].path
    const media = {
      pathId,
      file: file.substr(basePath.length + 1),
    }

    {
      // already in database with the same path?
      const res = await Media.search({
        pathId,
        // try both slashes to be POSIX/Win agnostic
        file: [media.file.replace('/', '\\'), media.file.replace('\\', '/')],
      })

      log('  => %s result(s) for existing media', res.result.length)

      if (res.result.length) {
        log('  => media is in library')
        return res.result[0]
      }
    }

    // new media
    // -------------------------------
    const stats = await stat(file)
    const { artist, title } = this.parser(path.parse(file).name)

    media.artist = artist
    media.title = title
    media.timestamp = new Date(stats.mtime).getTime()

    // need to look for an audio file?
    if (path.extname(file).toLowerCase() === '.cdg') {
      let audioFile

      // look for all uppercase and lowercase permutations of each
      // file extension since we may be on a case-sensitive fs
      for (const type of audioTypes) {
        for (const ext of getPerms(type)) {
          audioFile = file.substr(0, file.lastIndexOf('.') + 1) + ext

          // does file exist?
          try {
            await stat(audioFile)
            log('  => found %s audio', type)
            break
          } catch (err) {
            // try another permutation
            audioFile = null
          }
        } // end for

        if (audioFile) {
          try {
            const meta = await musicMeta.parseFile(audioFile, { duration: true })
            media.duration = meta.format.duration
            media.audioExt = path.extname(audioFile).replace('.', '')
            break
          } catch (err) {
            // try another type
            audioFile = null
            log(err)
          }
        }
      } // end for

      if (!audioFile) {
        throw new Error(`  => no valid audio file`)
      }
    } else if (path.extname(file).toLowerCase() === '.mp4') {
      // get video duration
      const info = await mp4info(file)
      media.duration = info.duration
    }

    if (!media.duration) {
      throw new Error(`  => could not determine duration`)
    }

    log('  => duration: %s:%s',
      Math.floor(media.duration / 60),
      Math.round(media.duration % 60, 10).toString().padStart(2, '0')
    )

    // add song
    const mediaId = await Media.add(media)

    this.emitLibrary()
    return mediaId
  }
}

// search each parent dir (up to baseDir)
async function getCfg (dir, baseDir) {
  const file = path.resolve(dir, 'kfconfig.js')

  try {
    await stat(file)
    log('Using config %s', file)
    return require(file)
  } catch (err) {
    log('No config found at %s', file)
  }

  if (dir === baseDir) {
    return
  }

  // try parent dir
  return getCfg(path.resolve(dir, '..'), baseDir)
}

// if (typeof song !== 'object') {
//   // try parent folder?
//   log(`  => couldn't parse artist/title from filename; trying parent folder name`)
//   song = parseMeta(cdgPathInfo.dir.split(cdgPathInfo.sep).pop())
//
//   if (typeof song !== 'object') {
//     return Promise.reject(new Error(`couldn't parse artist/title`))
//   }
// }

module.exports = FileScanner
