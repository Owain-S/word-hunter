import { Messages, WordMap, WordInfoMap, WordContext, StorageKey } from '../constant'
import { explainWord } from '../lib/openai'
import { syncUpKnowns, getLocalValue, getAllKnownSync, addLocalKnownsLogs, removeLocalKnownsLogs } from '../lib/storage'
import { settings } from '../lib/settings'
import { triggerGoogleDriveSyncJob, syncWithDrive } from '../lib/backup/sync'

let dict: WordInfoMap
let knowns: WordMap

async function readDict(): Promise<WordInfoMap> {
  const url = chrome.runtime.getURL('dict.json')
  const res = await fetch(url)
  const dict = await res.text()
  return JSON.parse(dict)
}

function updateBadge(wordsKnown: WordMap) {
  const knownWordsCount = Object.keys(wordsKnown).length
  let badgeText = knownWordsCount > 0 ? String(knownWordsCount) : ''
  if (knownWordsCount >= 1000 && knownWordsCount < 10000) {
    badgeText = badgeText.at(0) + '.' + badgeText.at(1) + 'k'
  }
  if (knownWordsCount >= 10000) {
    badgeText = badgeText.at(0)! + badgeText.at(1) + 'k'
  }
  chrome.action.setBadgeText({ text: badgeText })
  chrome.action.setBadgeBackgroundColor({ color: '#bbb' })
  chrome.action.setTitle({ title: '✔ ' + String(knownWordsCount) })
}

const playAudio = async (audio: string) => {
  const autioPageUrl = chrome.runtime.getURL('audio.html')
  const volume = settings().volume ?? 100

  if (!chrome.offscreen) {
    return createAudioWindow(`${autioPageUrl}?audio=${encodeURIComponent(audio)}&?volume=${volume}`)
  }

  await setupOffscreenDocument(autioPageUrl)
  chrome.runtime.sendMessage({
    type: 'play-audio',
    target: 'offscreen',
    data: {
      audio,
      volume
    }
  })
}

let creating: any // A global promise to avoid concurrency issues
const setupOffscreenDocument = async (path: string) => {
  // Check all windows controlled by the service worker to see if one
  // of them is the offscreen document with the given path
  if (await checkOffscreenDocumentExist(path)) return

  if (creating) {
    // create offscreen document
    await creating
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'play audio for word pronunciation'
    })
    await creating
    creating = null
  }
}

const checkOffscreenDocumentExist = async (offscreenUrl: string) => {
  // @ts-ignore
  if (chrome.runtime.getContexts) {
    // @ts-ignore
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    })
    return existingContexts.length > 0
    // @ts-ignore
  } else if (globalThis.clients) {
    // @ts-ignore
    const matchedClients = await globalThis.clients.matchAll()

    for (const client of matchedClients) {
      if (client.url === offscreenUrl) {
        return true
      }
    }
    return false
  }
  return false
}

const createAudioWindow = async (url: string) => {
  await chrome.windows.create({
    type: 'popup',
    focused: false,
    top: 1,
    left: 1,
    height: 1,
    width: 1,
    url
  })
}

function sendMessageToAllTabs(msg: any) {
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (!tab.url?.startsWith('chrome://extension')) {
        chrome.tabs.sendMessage(tab.id!, msg)
      }
    }
  })
}

/**
 * https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension/66618269#66618269
 * chrome connection will be auto disconnected after 5 minutes
 * so, we manually disconnect it after 4 minutes, then reconnect it in context script
 * to make sure the connection is always alive
 */
function autoDisconnectDelay(port: chrome.runtime.Port, tabId?: number) {
  if (!tabId) return
  setTimeout(() => {
    chrome.tabs.query({ currentWindow: true }, tabs => {
      const tab = tabs.find(t => t.id === tabId)
      if (tab) {
        port.disconnect()
      }
    })
  }, 250000)
}

chrome.runtime.onConnect.addListener(async port => {
  if (port.name === 'word-hunter') {
    knowns = knowns ?? (await getAllKnownSync())
    const tabId = port.sender?.tab?.id
    autoDisconnectDelay(port, tabId)

    port.onMessage.addListener(async msg => {
      // here, word and words are all in origin form
      const { action, word, words, context } = msg
      switch (action) {
        case Messages.set_known:
          knowns[word] = 'o'
          await syncUpKnowns([word], knowns, Date.now())
          updateBadge(knowns)
          sendMessageToAllTabs({ action, word })
          triggerGoogleDriveSyncJob()
          addLocalKnownsLogs([word])
          break
        case Messages.set_all_known:
          const addedWords = words.reduce((acc: WordMap, cur: string) => ({ ...acc, [cur]: 'o' }), {})
          Object.assign(knowns, addedWords)
          await syncUpKnowns(words, knowns, Date.now())
          updateBadge(knowns)
          sendMessageToAllTabs({ action, words })
          triggerGoogleDriveSyncJob()
          addLocalKnownsLogs(words)
          break
        case Messages.add_context: {
          const contexts = (await getLocalValue(StorageKey.context)) ?? {}
          // record context in normal tense word key
          const wordContexts = (contexts[word] ?? []) as WordContext[]
          if (!wordContexts.find(c => c.text === context.text)) {
            const newContexts = { ...contexts, [word]: [...wordContexts, context] }
            chrome.storage.local.set({
              [StorageKey.context]: newContexts,
              [StorageKey.context_update_timestamp]: Date.now()
            })
          }
          sendMessageToAllTabs({ action, context })
          triggerGoogleDriveSyncJob()
          break
        }
        case Messages.delete_context: {
          const contexts = (await getLocalValue(StorageKey.context)) ?? {}
          // delete context in normal tense word key
          const wordContexts = (contexts[word] ?? []) as WordContext[]
          const index = wordContexts.findIndex(c => c.text === context.text)
          if (index > -1) {
            wordContexts.splice(index, 1)
            const { [word]: w, ...rest } = contexts
            chrome.storage.local.set({
              [StorageKey.context]: wordContexts.length > 0 ? { ...rest, [word]: wordContexts } : rest,
              [StorageKey.context_update_timestamp]: Date.now()
            })
            sendMessageToAllTabs({ action, context })
            triggerGoogleDriveSyncJob()
          }
          break
        }
        case Messages.play_audio:
          playAudio(msg.audio)
          break
        case Messages.open_youglish:
          chrome.tabs.create({
            url: chrome.runtime.getURL('youglish.html') + `?word=${encodeURIComponent(word)}`
          })
          break
        case Messages.fetch_html: {
          const { url, uuid } = msg
          const htmlRes = await fetch(url, {
            mode: 'no-cors',
            credentials: 'include'
          })
          const htmlText = await htmlRes.text()
          port.postMessage({ result: htmlText, uuid })
          break
        }
        case Messages.ai_explain:
          const { text, uuid } = msg
          const explain = await explainWord(word, text, settings().openai.model)
          port.postMessage({ result: explain, uuid })
      }
    })
  }
})

// https://developer.chrome.com/docs/extensions/reference/contextMenus/#event-onInstalled
chrome.runtime.onInstalled.addListener(details => {
  chrome.contextMenus.create({
    id: 'word-hunter',
    title: 'Mark As Unknown',
    contexts: ['selection' as any]
  })

  readDict().then(localDict => {
    dict = localDict
    chrome.storage.local.set({ dict: localDict }, () => {
      console.log('[storage] dict set up when ' + details.reason)
    })
  })
})

function setFailedBadge(message: string) {
  chrome.action.setBadgeText({ text: '❌' })
  chrome.action.setTitle({ title: 'Google drive sync failed: ' + message })
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes[StorageKey.sync_failed_message]) {
    const { newValue } = changes[StorageKey.sync_failed_message]
    if (!!newValue) {
      setFailedBadge(newValue)
    } else {
      updateBadge(knowns)
    }
  }
})

//avoid reactivate service worker invoke syncWithDrive multiple times
chrome.runtime.onStartup.addListener(async () => {
  chrome.storage.local.set({ [Messages.app_available]: true })
  knowns = await getAllKnownSync()

  updateBadge(knowns)

  const syncFailedMessage = await getLocalValue(StorageKey.sync_failed_message)
  if (syncFailedMessage) {
    setFailedBadge(syncFailedMessage)
  }
  syncWithDrive(false)
})

chrome.runtime.onMessage.addListener(async msg => {
  if (Messages.app_available in msg) {
    chrome.action.setIcon({
      path: {
        128: msg.app_available ? chrome.runtime.getURL('icon.png') : chrome.runtime.getURL('icons/blind.png')
      }
    })

    chrome.storage.local.set({ [Messages.app_available]: msg.app_available })
    knowns = knowns ?? (await getAllKnownSync())
    updateBadge(msg.app_available ? knowns : {})
  }
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'word-hunter') {
    const word = info.selectionText?.trim()?.toLowerCase()
    dict = dict ?? (await getLocalValue(StorageKey.dict))
    if (word && word in dict) {
      const originFormWord = dict[word]?.o ?? word
      knowns = knowns ?? (await getAllKnownSync())
      delete knowns[originFormWord]
      await syncUpKnowns([word], knowns, Date.now())
      updateBadge(knowns)
      sendMessageToAllTabs({ action: Messages.set_unknown, word: originFormWord })
      triggerGoogleDriveSyncJob()
      removeLocalKnownsLogs(originFormWord)
    }
  }
})

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })
