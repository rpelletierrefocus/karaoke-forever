const db = require('sqlite')
const getFiles = require('../../thunks/getFiles')
const hashfiles = require('../../thunks/hashfiles')
const musicmetadata = require('../../thunks/musicmetadata')
const mp3duration = require('../../thunks/mp3duration')
const debug = require('debug')
const fs = require('fs')
const stat = require('../../thunks/stat')
const path = require('path')
const log = debug('app:provider:cdg')

const getLibrary = require('../../library/get')
const searchLibrary = require('../../library/search')
const addSong = require('../../library/addSong')
const parseArtistTitle = require('../../library/parseArtistTitle')

const LIBRARY_CHANGE = 'library/LIBRARY_CHANGE'
const PREFS_CHANGE = 'account/PREFS_CHANGE'

const allowedExts = ['.mp3', '.m4a']
let counts

async function scan(ctx, cfg) {
  if (!Array.isArray(cfg.paths) || !cfg.paths.length) {
    log('No paths configured; aborting scan')
    return Promise.resolve()
  }

  let validIds = [] // songIds for cleanup
  counts = {new: 0, ok: 0, skipped: 0}

  for (const dir of cfg.paths) {
    let files = []

    // get list of files
    try {
      log('searching path: %s', dir)
      files = await getFiles(dir, file => allowedExts.includes(path.extname(file).toLowerCase()))
      log('found %s files with valid extensions (%s)', files.length, allowedExts.join(','))
    } catch (err) {
      // try next configured path
      log(err.message)
      continue
    }

    for (let i=0; i < files.length; i++) {
      log('[%s/%s] %s', i+1, files.length, files[i])
      let songId, newCount

      try {
        songId = await process(files[i])
      } catch(err) {
        // try next file
        log(err.message)
        continue
      }

      validIds.push(songId)

      if (counts.new !== newCount) {
        newCount = counts.new
        // emit updated library
        ctx.io.emit('action', {
          type: LIBRARY_CHANGE,
          payload: await getLibrary(),
        })
      }

      // emit progress
      // ctx.io.emit('action', {
      //   type: PROVIDER_SCAN_STATUS,
      //   payload: {provider: 'cdg', pct: (files.length/i) * 100},
      // })
    }
  }



  // // delete songs not in our valid list
  // let res = await db.run('DELETE FROM songs WHERE provider = ? AND songId NOT IN ('+validIds.join(',')+')', payload)
  // log('cleanup: removed %s invalid songs', res.stmt.changes)
  //

  return Promise.resolve()
}


async function resource(ctx, cfg) {
  const { type, songId } = ctx.query
  let song, file, stats

  if (! type || ! songId) {
    ctx.status = 422
    return ctx.body = "Missing 'type' or 'songId' in url"
  }

  song = await db.get("SELECT json_extract(provider_json, '$.path') AS path FROM songs WHERE songId = ?", songId)

  if (! song) {
    ctx.status = 404
    return ctx.body = `songId not found: ${songId}`
  }

  if (type === 'audio') {
    file = song.path
    ctx.type = 'audio/mpeg'
  } else if (type === 'cdg') {
    let info = path.parse(song.path)
    file = song.path.substr(0, song.path.length-info.ext.length)+'.cdg'
  }

  // get file size (and does it exist?)
  try {
    stats = await stat(file)
  } catch(err) {
    ctx.status = 404
    return ctx.body = `File not found: ${file}`
  }

  // stream it!
  log('Streaming file: %s', file)

  ctx.length = stats.size
  ctx.body = fs.createReadStream(file)
}

module.exports = { scan, resource }


async function process(file){
  const pathInfo = path.parse(file)
  let stats, sha256, duration

  // does file exist?
  try {
    stats = await stat(file)
  } catch(err) {
    log('skipping: %s', err.message)
    counts.skipped++
    return Promise.reject(err)
}

  // already in database with the same path and mtime?
  res = await searchLibrary({
    meta: {
      path: file,
      mtime: stats.mtime.getTime() / 1000, // Date to timestamp (s)
    }
  })

  if (res.result.length) {
    log('song is in library (same path+mtime)')
    counts.ok++
    return Promise.resolve(res.result[0])
  }

  // need to hash the file(s)
  // (don't bother if CDG sidecar doesn't exist)
  const cdgFile = file.substr(0, file.length-pathInfo.ext.length)+'.cdg'

  try {
    await stat(cdgFile)
  } catch(err) {
    log('skipping: %s', err.message)
    counts.skipped++
    return Promise.reject(err)
  }

  log('getting sha256 (%s)', pathInfo.ext+'+.cdg')

  try {
    sha256 = await hashfiles([file, cdgFile], 'sha256')
  } catch(err) {
    log('skipping: %s', err.message)
    counts.skipped++
    return Promise.reject(err)
  }

  // --------
  // new song
  // --------

  // get duration in one of two ways depending on type
  try {
    if (pathInfo.ext === '.mp3') {
      log('getting duration (mp3duration)')
      duration = await mp3duration(file)
    } else {
      log('getting duration (musicmetadata)')
      let musicmeta = await musicmetadata(file, {duration: true})
      duration = musicmeta.duration
    }

    if (!duration) {
      throw new Error('unable to determine duration')
    }
  } catch(err) {
    log(err.message)
    counts.skipped++
    return Promise.reject(err)
  }

  // try getting artist and title from filename
  song = parseArtistTitle(pathInfo.name)

  if (typeof song !== 'object') {
    log('couldn\'t parse artist/title from filename (%s); trying parent folder', song)

    // try parent folder?
    song = parseArtistTitle(pathInfo.dir.split(pathInfo.sep).pop())

    if (typeof song !== 'object') {
      log('couldn\'t parse artist/title from folder: %s', song)
      return Promise.reject('couldn\'t parse artist/title')
    }
  }

  song.duration = Math.round(duration)
  song.provider = 'cdg'

  song.meta = {
    path: file,
    mtime: stats.mtime.getTime() / 1000, // Date to timestamp (s)
    sha256,
  }

  // add song
  try {
    const songId = await addSong(song)
    if (!Number.isInteger(songId)) {
      throw new Error('got invalid lastID')
    }

    counts.new++
    return Promise.resolve(songId)
  } catch(err) {
    counts.skipped++
    return Promise.reject(err)
  }
}
