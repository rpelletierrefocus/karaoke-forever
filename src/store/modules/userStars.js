import { REHYDRATE } from 'redux-persist'
import {
  STAR_SONG,
  UNSTAR_SONG,
  SONG_STARRED,
  SONG_UNSTARRED,
  STARS_PUSH,
  LOGIN,
  LOGOUT,
  CREATE,
  _SUCCESS,
  SOCKET_AUTH_ERROR,
} from 'shared/actions'

// ------------------------------------
// Action creators
// ------------------------------------
export function starSong (songId) {
  return {
    type: STAR_SONG,
    meta: { isOptimistic: true },
    payload: { songId },
  }
}

export function unstarSong (songId) {
  return {
    type: UNSTAR_SONG,
    meta: { isOptimistic: true },
    payload: { songId },
  }
}

// ------------------------------------
// Action Handlers
// ------------------------------------
const ACTION_HANDLERS = {
  [STAR_SONG]: (state, { payload }) => {
    // optimistic
    const songIds = state.starredSongs.slice() // copy
    songIds.push(payload.songId)

    return {
      ...state,
      starredSongs: songIds,
    }
  },
  [UNSTAR_SONG]: (state, { payload }) => {
    // optimistic
    const songIds = state.starredSongs.slice() // copy
    songIds.splice(songIds.indexOf(payload.songId), 1)

    return {
      ...state,
      starredSongs: songIds,
    }
  },
  [SONG_STARRED]: (state, { payload }) => {
    if (payload.userId !== state.userId) return state
    if (state.starredSongs.indexOf(payload.songId) !== -1) return state

    return {
      ...state,
      starredSongs: [...state.starredSongs, payload.songId],
    }
  },
  [SONG_UNSTARRED]: (state, { payload }) => {
    if (payload.userId !== state.userId) return state
    if (state.starredSongs.indexOf(payload.songId) === -1) return state

    const songs = state.starredSongs.slice() // copy
    songs.splice(songs.indexOf(payload.songId), 1)

    return {
      ...state,
      starredSongs: songs,
    }
  },
  [STARS_PUSH]: (state, { payload }) => ({
    ...state,
    ...payload,
  }),
  [LOGIN + _SUCCESS]: (state, { payload }) => ({
    ...state,
    userId: payload.userId,
  }),
  [CREATE + _SUCCESS]: (state, { payload }) => ({
    ...state,
    userId: payload.userId,
  }),
  [REHYDRATE]: (state, { payload }) => ({
    ...state,
    userId: payload && typeof payload.userId === 'number' ? payload.userId : null,
  }),
  [LOGOUT + _SUCCESS]: (state, { payload }) => ({
    ...initialState,
  }),
  [SOCKET_AUTH_ERROR]: (state, { payload }) => ({
    ...initialState,
  }),
}

// ------------------------------------
// Reducer
// ------------------------------------
let initialState = {
  userId: null,
  starredArtists: [],
  starredSongs: [],
}

export default function userStarsReducer (state = initialState, action) {
  const handler = ACTION_HANDLERS[action.type]

  return handler ? handler(state, action) : state
}