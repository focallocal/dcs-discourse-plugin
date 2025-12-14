import { u } from './utils'
import { DcsTag } from './DcsTag'
// Don't import this from "ComToClient.js" (notice the .js), as ComToClient.js
// is *not* part of the rollup bundle (so the path won't work once transferred
// to the plugin folder)
import { ComToClient } from './ComToClient'
import { loadWebsiteDescr, checkRoute, checkRedirect } from './websiteDescr'
import { discourseAPI } from './discourseAPI'
import User from 'discourse/models/user'
import Composer from 'discourse/models/composer'
import { NotificationLevels } from 'discourse/lib/notification-levels'

//------------------------------------------------------------------------------

/**
 * Retry a promise-returning function with exponential backoff
 * @param {() => Promise<T>} fn - Function that returns a promise
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} baseDelay - Initial delay in ms (doubles each retry)
 * @returns {Promise<T>}
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 500) {
	let lastError
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn()
		} catch (error) {
			lastError = error
			if (attempt < maxRetries) {
				const delay = baseDelay * Math.pow(2, attempt)
				console.warn(`[Docuss] Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms...`, error)
				await new Promise(resolve => setTimeout(resolve, delay))
			}
		}
	}
	throw lastError
}

//------------------------------------------------------------------------------
// Debug Timing System - Persistent Collection
// Collects timing data across page reloads for extended debugging sessions.
// Data is saved to localStorage continuously.
//
// Commands:
//   window.dcsTimingStart(hours)  - Start collecting (default 24 hours)
//   window.dcsTimingStop()        - Stop collecting and download logs
//   window.dcsTimingStatus()      - Check if collecting and time remaining
//   window.dcsTimingExport()      - Download all collected data
//   window.dcsTimingClear()       - Clear all collected data
//   window.dcsShowTimeline()      - Show current session in console
//------------------------------------------------------------------------------

const DCS_TIMING_CONFIG_KEY = 'dcs_timing_config'
const DCS_TIMING_EVENTS_KEY = 'dcs_timing_events'
const MAX_EVENTS_PER_SAVE = 50  // Batch size before auto-save
const MAX_TOTAL_EVENTS = 10000  // Cap to prevent localStorage overflow (~2-3MB)

const DcsTiming = {
	enabled: false,
	events: [],        // Current page session events (in memory)
	pendingEvents: [], // Events waiting to be saved to localStorage
	saveTimer: null,
	
	init() {
		// Check if we should be collecting (persists across page loads)
		this._loadConfig()
		
		// Listen for timing events from iframe
		window.addEventListener('message', (event) => {
			if (event.data && event.data.type === 'dcs-timing') {
				this.addEvent(event.data.source, event.data.event, event.data.details, event.data.timestamp)
			}
		})
		
		// Notify iframe of current state on load
		if (this.enabled) {
			console.log('⏱️ DCS Timing is ACTIVE (collecting). Run dcsTimingStatus() for details.')
			setTimeout(() => {
				const iframe = document.querySelector('#dcs-left-pane iframe')
				if (iframe) {
					iframe.contentWindow.postMessage({ type: 'dcs-timing-toggle', enabled: true }, '*')
				}
			}, 2000)
		}
		
		// Save pending events periodically
		this.saveTimer = setInterval(() => this._savePendingEvents(), 5000)
		
		// Save on page unload
		window.addEventListener('beforeunload', () => {
			if (this.pendingEvents.length > 0) {
				this._savePendingEvents()
			}
		})
		
		// Expose commands globally
		this._exposeCommands()
	},
	
	_exposeCommands() {
		// Start collecting for X hours (default 24)
		window.dcsTimingStart = (hours = 24) => {
			const expiresAt = Date.now() + (hours * 60 * 60 * 1000)
			this.enabled = true
			this.config = {
				enabled: true,
				startedAt: Date.now(),
				expiresAt: expiresAt,
				hours: hours
			}
			this._saveConfig()
			
			// Clear previous events if starting fresh
			localStorage.removeItem(DCS_TIMING_EVENTS_KEY)
			this.events = []
			this.pendingEvents = []
			
			console.log(`⏱️ DCS Timing started. Collecting for ${hours} hours.`)
			console.log(`⏱️ Will auto-stop at: ${new Date(expiresAt).toLocaleString()}`)
			console.log('⏱️ Data persists across page reloads. Run dcsTimingStop() when done.')
			
			// Log this page load
			this.log('Timing collection started', { hours, url: window.location.href })
			
			// Notify iframe
			const iframe = document.querySelector('#dcs-left-pane iframe')
			if (iframe) {
				iframe.contentWindow.postMessage({ type: 'dcs-timing-toggle', enabled: true }, '*')
			}
		}
		
		// Backwards compatibility
		window.dcsTimingOn = () => window.dcsTimingStart(24)
		
		// Stop collecting and download
		window.dcsTimingStop = () => {
			if (!this.enabled) {
				console.log('⏱️ Timing was not active.')
				return
			}
			
			// Save any pending events
			this._savePendingEvents()
			
			// Get total event count
			const allEvents = this._getAllEvents()
			
			if (allEvents.length > 0) {
				this._downloadAllEvents()
				console.log(`⏱️ Timing stopped. Downloaded ${allEvents.length} events.`)
			} else {
				console.log('⏱️ Timing stopped (no events collected).')
			}
			
			this.enabled = false
			this.config = { enabled: false }
			this._saveConfig()
			
			const iframe = document.querySelector('#dcs-left-pane iframe')
			if (iframe) {
				iframe.contentWindow.postMessage({ type: 'dcs-timing-toggle', enabled: false }, '*')
			}
		}
		
		// Backwards compatibility
		window.dcsTimingOff = window.dcsTimingStop
		
		// Check status
		window.dcsTimingStatus = () => {
			if (!this.enabled) {
				console.log('⏱️ Timing is NOT active.')
				const allEvents = this._getAllEvents()
				if (allEvents.length > 0) {
					console.log(`⏱️ ${allEvents.length} events saved from previous session. Run dcsTimingExport() to download.`)
				}
				return
			}
			
			const allEvents = this._getAllEvents()
			const remaining = this.config.expiresAt - Date.now()
			const hoursLeft = Math.max(0, remaining / (1000 * 60 * 60)).toFixed(1)
			const started = new Date(this.config.startedAt).toLocaleString()
			const expires = new Date(this.config.expiresAt).toLocaleString()
			
			console.log('⏱️ Timing is ACTIVE')
			console.log(`   Started: ${started}`)
			console.log(`   Expires: ${expires} (${hoursLeft} hours remaining)`)
			console.log(`   Events collected: ${allEvents.length}`)
			console.log(`   Events in memory: ${this.events.length + this.pendingEvents.length}`)
		}
		
		// Export all events
		window.dcsTimingExport = () => {
			this._savePendingEvents()
			const allEvents = this._getAllEvents()
			
			if (allEvents.length === 0) {
				console.log('⏱️ No events to export.')
				return
			}
			
			this._downloadAllEvents()
			console.log(`⏱️ Exported ${allEvents.length} events.`)
		}
		
		// Clear all data
		window.dcsTimingClear = () => {
			localStorage.removeItem(DCS_TIMING_EVENTS_KEY)
			this.events = []
			this.pendingEvents = []
			console.log('⏱️ All timing data cleared.')
		}
		
		// Backwards compatibility
		window.dcsTimingClearAll = window.dcsTimingClear
		
		// Show current session timeline in console
		window.dcsShowTimeline = () => {
			const allEvents = this._getAllEvents()
			
			if (allEvents.length === 0) {
				console.log('⏱️ No events recorded.')
				return
			}
			
			const sorted = [...allEvents].sort((a, b) => a.timestamp - b.timestamp)
			const baseTime = sorted[0].timestamp
			
			console.log('\n⏱️ ═══════════════════════════════════════════════════════════')
			console.log('⏱️ DCS TIMING TIMELINE')
			console.log('⏱️ ═══════════════════════════════════════════════════════════')
			
			// Group by page load
			let currentUrl = ''
			sorted.forEach(e => {
				if (e.details?.url && e.details.url !== currentUrl) {
					currentUrl = e.details.url
					console.log(`\n⏱️ --- Page: ${currentUrl} ---`)
				}
				const relTime = (e.timestamp - baseTime).toString().padStart(8, ' ')
				const source = (e.source || 'unknown').padEnd(12, ' ')
				const details = e.details ? ` | ${JSON.stringify(e.details)}` : ''
				console.log(`⏱️ ${relTime}ms [${source}] ${e.event}${details}`)
			})
			
			console.log('\n⏱️ ═══════════════════════════════════════════════════════════')
			const totalMs = sorted[sorted.length - 1].timestamp - baseTime
			const totalMins = (totalMs / 60000).toFixed(1)
			console.log(`⏱️ Total events: ${sorted.length}, Span: ${totalMs}ms (${totalMins} min)`)
			console.log('⏱️ ═══════════════════════════════════════════════════════════\n')
		}
		
		// Expose log function for other modules
		window.dcsTimingLog = (event, details = null) => {
			this.log(event, details)
		}
	},
	
	_loadConfig() {
		try {
			const stored = localStorage.getItem(DCS_TIMING_CONFIG_KEY)
			if (stored) {
				this.config = JSON.parse(stored)
				
				// Check if still valid (not expired)
				if (this.config.enabled && this.config.expiresAt > Date.now()) {
					this.enabled = true
					// Log this page load
					setTimeout(() => {
						this.log('Page loaded (timing active)', { url: window.location.href })
					}, 100)
				} else if (this.config.enabled) {
					// Expired
					console.log('⏱️ Timing collection period expired. Run dcsTimingExport() to download data.')
					this.enabled = false
					this.config.enabled = false
					this._saveConfig()
				}
			}
		} catch (e) {
			this.config = { enabled: false }
		}
	},
	
	_saveConfig() {
		try {
			localStorage.setItem(DCS_TIMING_CONFIG_KEY, JSON.stringify(this.config))
		} catch (e) {
			console.warn('⏱️ Could not save config:', e)
		}
	},
	
	_savePendingEvents() {
		if (this.pendingEvents.length === 0) return
		
		try {
			// Get existing events
			let allEvents = this._getAllEvents()
			
			// Add pending events
			allEvents = allEvents.concat(this.pendingEvents)
			this.pendingEvents = []
			
			// Cap total events to prevent overflow
			if (allEvents.length > MAX_TOTAL_EVENTS) {
				const removed = allEvents.length - MAX_TOTAL_EVENTS
				allEvents = allEvents.slice(removed)
				console.log(`⏱️ Event limit reached, removed ${removed} oldest events.`)
			}
			
			localStorage.setItem(DCS_TIMING_EVENTS_KEY, JSON.stringify(allEvents))
		} catch (e) {
			if (e.name === 'QuotaExceededError') {
				// Storage full, remove oldest half of events
				console.warn('⏱️ localStorage full, trimming old events...')
				let allEvents = this._getAllEvents()
				allEvents = allEvents.slice(Math.floor(allEvents.length / 2))
				localStorage.setItem(DCS_TIMING_EVENTS_KEY, JSON.stringify(allEvents))
			} else {
				console.warn('⏱️ Could not save events:', e)
			}
		}
	},
	
	_getAllEvents() {
		try {
			const stored = localStorage.getItem(DCS_TIMING_EVENTS_KEY)
			const savedEvents = stored ? JSON.parse(stored) : []
			// Include pending events not yet saved
			return savedEvents.concat(this.pendingEvents)
		} catch (e) {
			return this.pendingEvents.slice()
		}
	},
	
	_downloadAllEvents() {
		const allEvents = this._getAllEvents()
		if (allEvents.length === 0) return
		
		const sorted = [...allEvents].sort((a, b) => a.timestamp - b.timestamp)
		const baseTime = sorted[0].timestamp
		const startDate = new Date(baseTime)
		const endDate = new Date(sorted[sorted.length - 1].timestamp)
		
		const lines = [
			'DCS Timing Log - Extended Collection',
			'=====================================',
			`Exported: ${new Date().toISOString()}`,
			`Collection started: ${startDate.toISOString()}`,
			`Collection ended: ${endDate.toISOString()}`,
			`Duration: ${((endDate - startDate) / 60000).toFixed(1)} minutes`,
			`Total events: ${sorted.length}`,
			`User Agent: ${navigator.userAgent}`,
			'',
			'Timeline:',
			'---------'
		]
		
		// Group events by URL for readability
		let currentUrl = ''
		sorted.forEach(e => {
			if (e.details?.url && e.details.url !== currentUrl) {
				currentUrl = e.details.url
				lines.push('')
				lines.push(`=== PAGE: ${currentUrl} ===`)
			}
			const relTime = (e.timestamp - baseTime).toString().padStart(8, ' ')
			const absTime = new Date(e.timestamp).toISOString().substr(11, 12)
			const details = e.details ? ` | ${JSON.stringify(e.details)}` : ''
			lines.push(`${relTime}ms (${absTime}) [${e.source}] ${e.event}${details}`)
		})
		
		lines.push('')
		lines.push('---------')
		lines.push(`Total events: ${sorted.length}`)
		lines.push(`Total span: ${sorted[sorted.length - 1].timestamp - baseTime}ms`)
		
		const content = lines.join('\n')
		const blob = new Blob([content], { type: 'text/plain' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = `dcs-timing-${startDate.toISOString().replace(/[:.]/g, '-')}.txt`
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	},
	
	log(event, details = null) {
		if (!this.enabled) return
		this.addEvent('discourse', event, details, Date.now())
	},
	
	addEvent(source, event, details, timestamp) {
		if (!this.enabled) return
		
		const eventObj = { source, event, details, timestamp }
		this.events.push(eventObj)
		this.pendingEvents.push(eventObj)
		
		// Auto-save when batch is full
		if (this.pendingEvents.length >= MAX_EVENTS_PER_SAVE) {
			this._savePendingEvents()
		}
	}
}

// Initialize timing system
DcsTiming.init()

/**
 * @param {(string | boolean | IArguments)[]} args
 */
const log = (...args) => {
	//u.log(...args)
}

//------------------------------------------------------------------------------

export class DcsIFrame {
	//----------------------------------------------------------------------------
	// Constructor
	//----------------------------------------------------------------------------

	constructor(app, container) {
		this.container = container
		this.descrArray = null
		this.readyPromise = null
		this.currentRoute = null
		this.clientContext = null
		this.additionalRedirects = null
		this.connectionTimer = null
		this.pendingTopicPromises = new Map()
		
		// Route sequence tracking for race condition prevention
		// Incremented on each route change, included in m2 messages, echoed back in m6
		this.routeSequenceId = 0
		// Cache the last sent sequence ID to validate incoming responses
		this.lastSentSequenceId = 0

		// Listen for messages from fl-maps iframe
		window.addEventListener('message', (event) => {
			if (!event.data) {
				return
			}

			if (event.data.type === 'navigateTo') {
				const url = event.data.url
				const delay = event.data.delay || 0
				const waitForPageName = event.data.waitForPageName
				const waitTimeout =
					typeof event.data.waitTimeout === 'number'
						? event.data.waitTimeout
						: undefined
				console.log('📨 Received navigateTo message:', url, delay ? `(delayed ${delay}ms)` : '', waitForPageName ? `(wait for ${waitForPageName})` : '')
				this._handleNavigateTo({ url, delay, waitForPageName, waitTimeout })
				return
			}

			if (event.data.type === 'composeMessage') {
				const {
					recipients = 'moderators',
					subject,
					body,
					draftKey,
					pageName,
					focusComposer = true
				} = event.data

				const normalizedRecipients = Array.isArray(recipients)
					? recipients.filter(Boolean).join(', ')
					: (recipients || 'moderators')

				console.log('✉️ Received composeMessage request', {
					recipients: normalizedRecipients,
					subject,
					pageName
				})

				this.readyPromise
					.then(() => {
						let composerCtrl
						try {
							composerCtrl = container.lookup('controller:composer')
						} catch (lookupError) {
							console.warn('⚠️ Composer controller unavailable', lookupError)
							return
						}

						if (!composerCtrl) {
							console.warn('⚠️ Composer controller not found; cannot open message composer')
							return
						}

						let appEvents = null
						try {
							appEvents = container.lookup('service:app-events') || null
						} catch (_e) {
							appEvents = null
						}

						const finalSubject = subject || `Message to ${normalizedRecipients}`
						const finalBody = body || ''
						const finalDraftKey = draftKey || `docuss-message-${pageName || Date.now()}`

						schedule('afterRender', () => {
							try {
								composerCtrl.open({
									action: Composer.PRIVATE_MESSAGE,
									draftKey: finalDraftKey,
									recipients: normalizedRecipients,
									archetypeId: 'private_message',
									topicTitle: finalSubject,
									raw: finalBody
								})

								if (focusComposer && typeof composerCtrl.focusComposer === 'function') {
									composerCtrl.focusComposer()
								} else if (focusComposer && appEvents?.trigger) {
									appEvents.trigger('composer:focus')
								}
							} catch (error) {
								console.error('❌ Failed to open Discourse composer for Docuss message', error)
							}
						})
					})
					.catch(error => {
						console.error('❌ Failed to handle composeMessage request', error)
					})

				return
			}
		})

		/*
    discourseAPI.newTags(['tete']).then(() => {
      discourseAPI.setTagNotification({ tag: 'tete', notificationLevel: 3 })
    })
    */

		// Check Discourse settings
		const siteSettings = container.lookup('service:site-settings')
		const jsonUrlsStr = siteSettings.docuss_website_json_file;
		if (!jsonUrlsStr) {
			this._displayError(
				'Error in Discourse settings',
				'At least one "docuss website json file" must be set'
			)
			this.readyPromise = Promise.reject('Docuss error, see the home page')
			return
		}
		const jsonUrls = jsonUrlsStr
			.split('|')
			.filter(url => url.trim() && !url.startsWith('DISABLE'))
		if (!jsonUrls.length) {
			this._displayError(
				'Error in Discourse settings',
				'All files in "docuss website json file" are disabled'
			)
			this.readyPromise = Promise.reject('Docuss error, see the home page')
			return
		}
		if (!siteSettings.tagging_enabled) {
			this._displayError(
				'Error in Discourse settings',
				'"tagging enabled" must be set to true'
			)
			this.readyPromise = Promise.reject('Docuss error, see the home page')
			return
		}
		const proxyUrl = siteSettings.docuss_proxy_url
		if (proxyUrl) {
			try {
				this.parsedProxyUrl = new URL(proxyUrl)
			} catch (e) {
				this._displayError(
					'Error in Discourse settings',
					'Invalid url in "docuss proxy url"'
				)
				this.readyPromise = Promise.reject('Docuss error, see the home page')
				return
			}
		}

		/*
    // Unfortunately, those 2 settings are server-side only
    if (container.lookup('site-settings:main').allow_duplicate_topic_titles < DcsTag.MIN_TAG_LENGTH) {    
      settingsError('"allow duplicate topic titles" must be set to true')
      return
    }  
    if (container.lookup('site-settings:main').min_trust_to_create_tag !== '0') {    
      settingsError(`"min trust to create tags" must be set to 0`)
      return
    }
    */

		// Get all category names
		const appCtrl = container.lookup('controller:application')
		const validCatNames = appCtrl.site.categories.map(c => c['name'])

		// Load and check the JSON descriptor file
		const descrPromise = loadWebsiteDescr(jsonUrls, validCatNames, proxyUrl)
			.then(descrArray => {
				// Init dcsTag
				const dcsTagSettings = descrArray[0].dcsTag
				DcsTag.init(dcsTagSettings)

				// Check tag max length against Discourse settings
				const maxTagLength1 = DcsTag.maxTagLength()
				const maxTagLength2 = siteSettings.max_tag_length
				if (maxTagLength1 > maxTagLength2) {
					throw `dcsTag=${JSON.stringify(
						DcsTag.getSettings()
					)} implies a max tag length of ${maxTagLength1}, which doesn't match Discourse setting "max tag length"=${maxTagLength2}`
				}

				// Check tag case against Discourse settings
				const forceLowercase1 = DcsTag.getSettings().forceLowercase
				const forceLowercase2 = siteSettings.force_lowercase_tags
				if (forceLowercase1 !== forceLowercase2) {
					throw `dcsTag.forceLowercase=${forceLowercase1} doesn't match Discourse setting "force lowercase tags"=${forceLowercase2}`
				}

				return descrArray
			})
			.catch(e => {
				if (typeof e === 'string') {
					this._displayError('Docuss - Error in website JSON file', e)
					throw 'Docuss error, see the home page'
				}

				throw e
			})

		const tagsPromise = retryWithBackoff(
			() => discourseAPI.getTagList(),
			3,  // max 3 retries
			500 // start with 500ms delay, doubles each retry
		).catch(e => {
			console.warn('[Docuss] Tags fetch failed after all retries, continuing with empty tags', e)
			// Return empty tags object so the app can continue
			return { tags: [{ id: 'dcs-comment', count: 0 }, { id: 'dcs-discuss', count: 0 }] }
		})

		this.readyPromise = Promise.all([descrPromise, tagsPromise]).then(res => {
			// Store the descr array
			this.descrArray = res[0]

			// Get the tag list
			const tags = res[1]['tags']

			// Check for required tags
			const check = tag => {
				if (!tags.find(tagObj => tagObj['id'] === tag)) {
					this._displayError(
						'Error in Docuss setup',
						`Missing required tag "${tag}"`
					)
					throw 'Docuss error - See the error message in the app'
				}
			}
			check('dcs-comment')
			check('dcs-discuss')

			// Extract docuss tags. Beware that we need to wait for descrPromise
			// to resolve before we can do this, because we need the DcsTag
			// to be initialized
			const allCounts = tags.reduce((res, tagObj) => {
				const tag = tagObj['id']
				const count = tagObj['count']
				if (count !== 0) {
					const parsed = DcsTag.parse(tag)
					if (parsed) {
						const { pageName, triggerId } = parsed
						res.push({ pageName, triggerId, count })
					}
				}
				return res
			}, [])

			// Distribute counts in their respective descr
			this.descrArray.forEach(descr => {
				const pageNames = descr.pages.map(sp => sp.name)
				const counts = allCounts.filter(
					c =>
						pageNames.includes(c.pageName) ||
						(descr.webApp &&
							c.pageName.startsWith(descr.webApp.otherPagesPrefix))
				)
				descr.counts = serializeCounts(counts)
			})
		})

		// Set the message handlers
		ComToClient.onSetDiscourseRoute(this.onSetDiscourseRoute.bind(this))
		ComToClient.onSetRouteProps(this.onSetRouteProps.bind(this))
		ComToClient.onSetRedirects(this.onSetRedirects.bind(this))
		ComToClient.onCreateDcsTags(this.onCreateDcsTags.bind(this))
		ComToClient.onCreateTopic(this.onCreateTopic.bind(this))
	}

	//----------------------------------------------------------------------------
	// Public interface
	//----------------------------------------------------------------------------

	// Return a promise that resolves to 'ready' or 'failure'
	readyForTransitions() {
		return this.readyPromise
	}

	/**
   * @param {Route} route
   */
	didTransition(route) {
		u.dev.assert(this.descrArray)
		log('didTransition: ', route)

		//================================
		
		// Increment route sequence ID for race condition prevention
		// This ID will be sent with m2 and expected back with m6
		this.routeSequenceId++
		log('didTransition: routeSequenceId now', this.routeSequenceId)

		//================================

		// resolve empty page name for route "docuss"
		// We *need* a complete route, because the route will be forwarded to client
		if (route.layout === 0 && !route.pageName) {
			route.pageName = this.descrArray[0].pages[0].name
		}

		const error = checkRoute(route)
		if (error) {
			u.throw(`Invalid route ${JSON.stringify(route)} - ${error}`)
		}

		//================================

		// Get all redirects
		const descrRedirects = this.descrArray.reduce(
			(res, da) => res.concat(da.redirects || []),
			[]
		)
		const redirects = descrRedirects.concat(this.additionalRedirects || [])

		// Find a redirect matching the current route change
		const destRoute = getRedirectedRoute({ src: route, redirects })

		// Redirect and quit
		if (destRoute) {
			log('Redirect to ', destRoute)

			this._goToRouteFromClient({
				route: destRoute,
				mode: 'REPLACE',
				clientContext: this.clientContext // Keep the same clientContext
			})

			return true
		}

		//================================

		// Pause video when leaving the iframe page entirely (layout changes from 0 to non-0)
		// Layout 0 = iframe only (event pages with video)
		// Layout 2/3 = split view or Discourse only (forum discussions)
		// This prevents videos from continuing to play when navigating to forum
		if (this.currentRoute && 
		    this.currentRoute.layout === 0 && 
		    route.layout !== 0 &&
		    this.currentRoute.pageName === route.pageName) {
			this._pauseVideoInIframe()
		}

		this.currentRoute = route
		DcsTiming.log('Route changed', { pageName: route.pageName, layout: route.layout, triggerId: route.triggerId })

		//================================

		// Case FULL_DISCOURSE
		if (route.layout === 1) {
			if (!this.currentDescr) {
				// When we load the application on a FULL_DISCOURSE route, we set
				// the logo and menu to the first website. THIS WILL PROBABLY NEED
			// TO BE CHANGED, as some user want a dedicated Discourse category
			// per website. When initially loading the app on this category, the
			// corresponding website should be set instead of the first one.
			this.currentDescr = this.descrArray[0]
			document.documentElement.classList.add(`dcs-website-${this.currentDescr.websiteName}`)
			if (this.currentDescr.logo) {
				this.container.dcsHeaderLogo.setLogo(this.currentDescr.logo)
			}
			}

			this._notifyClientOfCurrentRoute()

			return false
		}

		//================================

		// Get the descr and page corresponding to the pageName
		let page = null
		const descr = this.descrArray.find(d => {
			page = d.pages.find(p => p.name === route.pageName)
			return (
				!!page ||
				(d.webApp && route.pageName.startsWith(d.webApp.otherPagesPrefix))
			)
		})

		// Case we didn't find the descr
		if (!descr) {
			this._displayError(
				'Page Not Found',
				`Unknown page "${route.pageName}".<br>` +
					'Use the top left logo to come back to safety.'
			)
			return false
		}

		// If the descr has changed...
		if (descr !== this.currentDescr) {
			// Set the descr class
			if (this.currentDescr) {
				document.documentElement.classList.remove(`dcs-website-${this.currentDescr.websiteName}`)
			}
			document.documentElement.classList.add(`dcs-website-${descr.websiteName}`)
			this.currentDescr = descr

			// Set the descr logo
			const homePath =
				this.currentDescr === this.descrArray[0]
					? null
					: `/docuss/${this.currentDescr.pages[0].name}`
			const logo = Object.assign({}, this.currentDescr.logo, { href: homePath })
			this.container.dcsHeaderLogo.setLogo(logo)

			// If there is no page, it means we are in a web app. Because the descr
			// has just changed, we need to load the web app url.
			page = page || descr.pages[0]
		}

		// Case webApp with no need for reloading the url
		if (!page) {
			this._notifyClientOfCurrentRoute()
			return false
		}

		// Get the page url
		let url = page.url
		if (page.needsProxy) {
			const parsedUrl = new URL(url)
			parsedUrl.protocol = this.parsedProxyUrl.protocol
			parsedUrl.hostname += '.' + this.parsedProxyUrl.hostname
			if (this.parsedProxyUrl.port) {
				parsedUrl.port = this.parsedProxyUrl.port
			}
			url = parsedUrl.href
		}

		// Load the url
		if (url !== this.currentUrl) {
			this.clientContext = null // New page = new clientContext
			this._loadPage({
				url,
				onConnectedOrReconnected: () => {
					if (this.connectionTimer) {
						clearTimeout(this.connectionTimer)
						this.connectionTimer = null
					}
					this._notifyClientOfCurrentRoute()
				}
			})
			this.currentUrl = url
		} else {
			this._notifyClientOfCurrentRoute()
		}

		return false
	}

	//----------------------------------------------------------------------------
	// Private methods
	//----------------------------------------------------------------------------

	/**
   * @param {Object} args
   * @param {Object} args.descr
   * @param {Route} args.route
   */
	_notifyClientOfCurrentRoute() {
		u.dev.assert(this.currentRoute)
		u.dev.assert(this.currentDescr)

		// Track the sequence ID we're sending so we can validate responses
		this.lastSentSequenceId = this.routeSequenceId

		// Beware, there might be no page previously loaded (so no comToClient
		// yet): this is the case when startup occurs on a pure Discourse route
		// (such as Admin)
		if (ComToClient.isConnected()) {
			ComToClient.postDiscourseRoutePushed({
				route: this.currentRoute,
				descr: this.currentDescr.originalDescr,
				counts: this.currentDescr.counts,
				clientContext: this.clientContext,
				origin: location.origin,
				routeSequenceId: this.routeSequenceId
			})

			// Also send via postMessage for direct consumption by fl-maps
			const iframe = this.container.dcsLayout.left
			if (iframe && iframe.contentWindow && this.currentRoute.topic) {
				console.log('📤 Sending dcsRoute postMessage with topic:', this.currentRoute.topic)
				DcsTiming.log('Sending dcsRoute postMessage', { topic: this.currentRoute.topic?.id })
				iframe.contentWindow.postMessage({
					type: 'dcsRoute',
					topic: this.currentRoute.topic
				}, '*')
			}

			// Send dcsOpenForm message for m_gather2 and m_gather3 pages
			// This tells fl-maps to open the new event form with a specific formType
			// Retry mechanism: send immediately, then at 500ms and 1500ms for Brave compatibility
			if (iframe && iframe.contentWindow) {
				const pageName = this.currentRoute.pageName
				if (pageName === 'm_gather2' || pageName === 'm_gather3') {
					const formType = pageName === 'm_gather2' ? 2 : 3
					const sendFormMessage = () => {
						console.log(`📤 Sending dcsOpenForm postMessage for form type ${formType}`)
						DcsTiming.log('Sending dcsOpenForm', { formType })
						iframe.contentWindow.postMessage({
							type: 'dcsOpenForm',
							formType: formType
						}, '*')
					}
					
					// Send immediately and retry twice for browsers where listener may not be ready
					sendFormMessage()
					setTimeout(sendFormMessage, 500)
					setTimeout(sendFormMessage, 1500)
				}
			}
		}

		this.clientContext = null
	}

	_pauseVideoInIframe() {
		// Pause any playing videos when navigating away from an event page
		const iframe = this.container.dcsLayout?.left
		if (iframe && iframe.contentWindow) {
			try {
				iframe.contentWindow.postMessage({
					type: 'pauseVideo'
				}, '*')
				console.log('📤 Sent pauseVideo message to iframe')
			} catch (e) {
				console.warn('Failed to send pauseVideo message:', e)
			}
		}
	}

	_loadPage({ url, onConnectedOrReconnected }) {
		// Reset
		ComToClient.disconnect()
		DcsTiming.log('Loading iframe page', { url })

		// Build the target url
		const parsedUrl = new URL(url)
		parsedUrl.hash = location.hash

		// Add a query param to ask for login (in case the page or app supports it)
		if (User.current()) {
			parsedUrl.searchParams.set('discourse-login', true)
		}

		// Create the iframe with the right url.
		DcsTiming.log('Creating iframe element')
		this.container.dcsLayout.replaceLeftWithIFrame(parsedUrl.href)

		// Connect to the iframe
		DcsTiming.log('Initiating Bellhop connection')
		ComToClient.connect({
			iframeElement: this.container.dcsLayout.left,
			iframeOrigin: parsedUrl.origin,
			onConnected: () => {
				DcsTiming.log('Bellhop connected to iframe')
				if (onConnectedOrReconnected) onConnectedOrReconnected()
			}
			/*
      timeout: 10000,
      onTimeout: () => {
        this._displayError(
          'Docuss Error: connection timeout',
          'Communication could not be established with the embedded website.<br />' +
            'Please check that it includes one of the Docuss ' +
            '<a href="https://github.com/sylque/dcs-client" target="_blank">client libraries</a>.'
        )
        //reject() WE DON'T WANT TO DISPLAY AN "Uncaught (in promise)" additional error
      }
      */
		})

		// In the past, we used to display the error below as a connection timeout.
		// But this didn't work: users repeatedly complained about their website
		// sometimes hanging with the timeout error. My hypothesis is that the error
		// was due to very slow Internet connection on mobile. So one solution could
		// have been to increase the timeout from 10s to 20s or more (after all,
		// typical browser timeout is 5 minutes!). But then, webmasters forgetting
		// to add a dcs-client library to their page would not have seen the error
		// message soon enough.
		if (this.connectionTimer) {
			clearTimeout(this.connectionTimer)
		}
		this.connectionTimer = setTimeout(() => {
			u.logWarning(
				'For 10 seconds now, the Docuss plugin is trying to connect to ' +
					`the iframe displaying this url: ${url}. Possible issues: ` +
					'1. your Internet connection is slow and everything will be working ' +
					'fine once the iframe has finished loading ' +
					'2. the page in the iframe does not include one of the Docuss client ' +
					'libraries (see more information at https://github.com/sylque/dcs-client).' +
					'3. the page in the iframe is a web app which has crashed.'
			)
			this.connectionTimer = null
		}, 10000)
	}

	_displayError(title, msg) {
		//u.logError(title + '. ' + msg) //DISPLAYS HTML MARKUP + RISK TO CONFUSE PEOPLE, BETTER LET THE MAIN SCREEN DISPLAY THE ERROR

		ComToClient.disconnect()
		this.currentUrl = null

		afterRender().then(() => {
			this.container.dcsLayout.replaceLeftWithDiv(`<h3>${title}</h3>${msg}`)
		})

		// Wait after load time transition (otherwise it will be put back)
		u.async.delay(2000).then(() => {
			this.container.dcsLayout.setLayout(0)
		})
	}

	_goToPathFromClient({ path, hash, mode, clientContext }) {
		// Get the router
		const router = this.container.lookup('service:router')
		// Change the route (it will do nothing if the path is the same)
		const transition =
			mode === 'PUSH' ? router.transitionTo(path) : router.replaceWith(path)
		const transitionActuallyOccurred = !!transition['intent']
		if (transitionActuallyOccurred) {
			this.clientContext = clientContext
		}

		// Ember doesn't support anchors. So we need to manage them manually.
		// https://github.com/discourse/discourse/blob/35bef72d4ed6d530468bdc091bc076d431a2cdc4/app/assets/javascripts/discourse/lib/discourse-location.js.es6#L85
		try {
			const location = this.container.lookup('location:discourse-location')
			if (location && hash !== window.location.hash) {
				const url = hash || path // "hash" to set the hash, "path" to reset the hash
				transition.then(() => {
					if (mode === 'REPLACE' || transitionActuallyOccurred) {
						if (typeof location['replaceURL'] === 'function') {
							location['replaceURL'](url)
						}
					} else {
						if (typeof location['setURL'] === 'function') {
							location['setURL'](url)
						}
					}
				})
			}
		} catch (e) {
			// Location service may not be available or structure may have changed
			console.warn('Failed to handle location hash:', e)
		}
	}

	/**
   *  @param {SetRouteParams}
   */
	_goToRouteFromClient({ route, mode, clientContext }) {
		const error = checkRoute(route)
		if (error) {
			u.throw(`Invalid route ${JSON.stringify(route)} - ${error}`)
		}
		u.throwIfNot(
			mode === 'PUSH' || mode === 'REPLACE',
			'setDiscourseRoute: missing or invalid argument "mode"'
		)

		// Case FULL_CLIENT
		if (route.layout === 0) {
			this._goToPathFromClient({
				path: `/docuss/${route.pageName}`,
				hash: route.hash,
				mode,
				clientContext
			})
			return
		}

		// Case FULL_DISCOURSE
		if (route.layout === 1) {
			this._goToPathFromClient({ path: route.pathname, mode, clientContext })
			return
		}

		// Case WITH_SPLIT_BAR

		const { pageName, interactMode, triggerId, composerTemplate } = route
		const dcsTag = DcsTag.build({ pageName, triggerId })
		const baseQueryParts = []
		// CRITICAL FIX: Always add query param to explicitly control layout
		// layout 2 = split view (r=false), layout 3 = Discourse only (r=true)
		// Default to layout 2 (split view) if not specified
		if (route.layout === 3) {
			baseQueryParts.push('r=true')
		} else {
			// layout 2 or undefined → use split view
			baseQueryParts.push('r=false')
		}
		
		// Add composer_template parameter based on explicit composerTemplate or interactMode
		// This enables the url-composer-templates component to pre-fill text
		if (composerTemplate) {
			// If explicitly provided via data-dcs-composer-template, use it
			baseQueryParts.push(`composer_template=${composerTemplate}`)
		} else if (interactMode === 'DISCUSS') {
			// For discuss mode, check if triggerId suggests a specific template
			// Default to 'report' for general discussions
			if (triggerId && triggerId.includes('going')) {
				baseQueryParts.push('composer_template=going')
			} else if (triggerId && triggerId.includes('invite')) {
				baseQueryParts.push('composer_template=invite')
			} else {
				baseQueryParts.push('composer_template=report')
			}
		} else if (interactMode === 'COMMENT') {
			// For comment mode, default to 'report' template
			baseQueryParts.push('composer_template=report')
		}
		
		const intersectionQueryParts = baseQueryParts.slice()
		const intersectionQuery = intersectionQueryParts.length
			? `?${intersectionQueryParts.join('&')}`
			: ''
		const topicQuery = baseQueryParts.length
			? `?${baseQueryParts.join('&')}`
			: ''

		// Case WITH_SPLIT_BAR + DISCUSS
		if (interactMode === 'DISCUSS') {
			this._goToPathFromClient({
				path: `/tags/intersection/dcs-discuss/${dcsTag}${intersectionQuery}`,
				hash: route.hash,
				mode,
				clientContext
			})
			return
		}

		// Case WITH_SPLIT_BAR + COMMENT
		discourseAPI
			.getTopicList({ tag: dcsTag })
			.then(topicList => {
					// Case there's no topic with this tag yet: see next "then"
					if (!topicList.length) {
						return 'not found'
					}

					// Case topics have been found: go through those topics and find
					// the first one that also has the tag 'dcs-comment'
					const topic = topicList.find(t => t['tags'].includes('dcs-comment'))

					// If no such topic is found, there something wrong (should never
					// happen)
					u.throwIf(!topic, 'Error: no dcs-comment topic found in', topicList)

					// Display the topic
					// Don't forget the slug, otherwise Discourse will go through the
					// intermediate route "topicBySlugOrId" that never resolves (i.e.
					// transition.then() is never called)
					this._goToPathFromClient({
						path: `/t/${topic.slug}/${topic.id}${topicQuery}`,
						hash: route.hash,
						mode,
						clientContext
					})

					return 'ok'
			}, e => 'not found')
			.then(res => {
				// Case there's no topic with this tag yet
				if (res === 'not found') {
					this._goToPathFromClient({
						path: `/tags/intersection/dcs-comment/${dcsTag}${intersectionQuery}`,
						hash: route.hash,
						mode,
						clientContext
					})
				}
			})
	}

	//----------------------------------------------------------------------------
	// Handlers for client messages
	//----------------------------------------------------------------------------

	/**
   *  @param {SetRouteParams}
   */
	onSetDiscourseRoute({ route, mode, clientContext }) {
		// DON'T USE arguments[0], see https://github.com/google/closure-compiler/issues/3285
		log('onSetDiscourseRoute: ', route, mode, clientContext)
		this._goToRouteFromClient({ route, mode, clientContext })
	}

	/**
   *  @param {RouteProps} args
   */
	onSetRouteProps(args) {
		log('onSetRouteProps: ', arguments)

		const { error, category, discourseTitle, routeSequenceId } = args

		// ============================================================
		// RACE CONDITION PREVENTION: Validate route sequence ID
		// ============================================================
		// If the message's sequence ID doesn't match our current route,
		// this message is stale (user navigated away before it arrived).
		// We skip it gracefully and ensure the page is in a valid state.
		
		if (routeSequenceId !== undefined && routeSequenceId !== this.routeSequenceId) {
			console.debug('[Docuss] onSetRouteProps skipped (stale)', {
				reason: 'sequence-mismatch',
				messageSequenceId: routeSequenceId,
				currentSequenceId: this.routeSequenceId,
				currentRoute: this.currentRoute
			})
			// Message is stale - don't apply it, but ensure valid state
			// The current route should already be correctly displayed
			return
		}

		// Case error
		if (error) {
			u.logError(error)
			this._displayError(error, `Use the top left logo to come back to safety.`)
			return
		}

		// Apply any pending layout from connection retry logic
		if (this.container._docussPendingLayout) {
			const { layout } = this.container._docussPendingLayout
			console.log('\u2713 iframe connected, applying pending layout:', layout)
			
			// Clear connection timeout
			if (this.container._docussConnectionTimer) {
				clearTimeout(this.container._docussConnectionTimer)
				this.container._docussConnectionTimer = null
			}
			
			// Clear spinner timer
			if (this.container._docussSpinnerTimer) {
				clearTimeout(this.container._docussSpinnerTimer)
				this.container._docussSpinnerTimer = null
			}
			
			// Reset retry count
			this.container._docussRetryCount = 0
			
			// Hide spinner
			const spinner = document.getElementById('dcs-loading-spinner')
			if (spinner) {
				spinner.classList.remove('visible')
				setTimeout(() => {
					if (spinner.parentNode) {
						spinner.parentNode.removeChild(spinner)
					}
				}, 250)
			}
			
			// Set the layout
			this.container.dcsLayout.setLayout(layout)
			
			// Clear pending layout
			delete this.container._docussPendingLayout
		}

		// Check that the layout is WITH_SPLIT_BAR. If it is not, it doesn't mean
		// something is wrong. When clicking quickly on a menu, Discourse might
		// already have changed the route to a non WITH_SPLIT_BAR page when the
		// setRouteProps message arrives
		const layout = this.currentRoute?.layout
		const docussLayoutActive = layout === 2 || layout === 3
		const appCtrl = this.container.lookup('controller:application')
		let resolvedCategory = null
		let resolvedCategoryId = null

		if (category && appCtrl?.site?.categories) {
			resolvedCategory = appCtrl.site.categories.find(c => {
				if (!c) {
					return false
				}
				const candidateName = c['name']
				const candidateSlug = c['slug']
				const candidateId = c['id']
				return (
					candidateName === category ||
					candidateSlug === category ||
					String(candidateId) === String(category)
				)
			})

			if (resolvedCategory) {
				resolvedCategoryId = resolvedCategory.id
			}
		}

		if (!docussLayoutActive) {
			console.debug('[Docuss] onSetRouteProps skipped', {
				reason: 'layout-not-split',
				currentRoute: this.currentRoute,
				incomingCategory: category,
				resolvedCategoryId
			})
			this.container.isDocussActive = false
			
			// ============================================================
			// RECOVERY: Ensure page is in a valid display state
			// ============================================================
			// If layout is 0, we should be showing iframe only
			// If layout is 1, we should be showing Discourse only
			// Make sure the current layout is correctly applied
			if (this.currentRoute?.layout !== undefined) {
				this.container.dcsLayout.setLayout(this.currentRoute.layout)
			}
			
			if (category && !resolvedCategory) {
				u.logError(`Category "${category}" not found in Discourse`)
			}
			return
		}

		this.container.isDocussActive = true
		console.debug('[Docuss] onSetRouteProps accepted', {
			layout,
			incomingCategory: category,
			resolvedCategoryId,
			currentRoute: this.currentRoute
		})

		// Set title
		if (discourseTitle) {
			// Escape the title
			const safeTitle = escapeHtml(discourseTitle)

			// Remove previous title if any
			const titlePrefix = document.querySelector('.dcs-title-prefix')
			if (titlePrefix) {
				titlePrefix.remove()
			}

			// In tag route, we add the title at the top of the page
			/*
      const navContainer = document.querySelector('.navigation-container')
      const h1 = document.createElement('h1')
      h1.className = 'dcs-title-prefix'
      h1.textContent = safeTitle
      navContainer.parentNode.insertBefore(h1, navContainer.nextSibling)
      */
			const tagShowHeading = document.querySelector('.tag-show-heading')
			if (tagShowHeading) {
				tagShowHeading.textContent = safeTitle
				tagShowHeading.style.display = 'inline-flex'
			}

			// In topic route, we transform the topic title. The issue here is that
			// the title is rendered very late, so we nee to wait until the title
			// has been rendered before we can transform it. Also, beware that the
			// route can change while we are waiting! (we don't want to transform the
			// title of another topic)
			const router = this.container.lookup('service:router')
			const hasTitle = () => {
				if (!router['currentPath'].startsWith('topic.')) {
					throw 'bad route'
				}
				const titleEl = document.querySelector('.fancy-title')
				return titleEl && titleEl
			}
			u.async
				.retryDelay(hasTitle, 15, 200, 'title not found') // 15*200 = 3s
				.then(
					titleEl => {
						if (this.currentRoute.interactMode === 'COMMENT') {
							titleEl.textContent = safeTitle

							// By default, the title is hidden with css, so bring it back
							const topicTitle = document.getElementById('topic-title')
							if (topicTitle) {
								topicTitle.style.display = 'block'
							}

							// Is there a topic map? The topic map is th grey rectangular area
							// containing the number of posters, viewers, etc.
							const topicMap = document.querySelector('.topic-map')
							if (topicMap) {
								// Make room of moving the topic map on top of the title (see
								// the css)
								if (topicTitle) {
									topicTitle.style.marginTop = '50px'
								}
							}
						} else {
							const topicCtrl = this.container.lookup('controller:topic')
							const originalTitle = topicCtrl.get('model.title')
							titleEl.innerHTML =
								`<span class="dcs-title-prefix">${safeTitle} | </span>${originalTitle}`
						}
					},
					e => {
						if (e === 'bad route') {
							// No error here. It's just that we are not on a route where it makes
							// sense to set the title.
						} else {
							u.logError(e)
						}
					}
				)
		}

		// Set category
		if (resolvedCategory) {
				const applyCategoryToController = controller => {
					if (!controller) {
						return false
					}
					try {
						if (typeof controller.set === 'function') {
							controller.set('category', resolvedCategory)
							controller.set('canCreateTopicOnCategory', true)
						} else {
							controller.category = resolvedCategory
							controller.canCreateTopicOnCategory = true
						}
						return true
					} catch (controllerError) {
						console.warn('Failed to update Docuss discovery controller category:', controllerError)
						return false
					}
				}

				applyCategoryToController(this.container.lookup('controller:tags-show'))
				applyCategoryToController(this.container.lookup('controller:tag-show'))
				applyCategoryToController(this.container.lookup('controller:tags'))

				try {
					const composerCtrl = this.container.lookup('controller:composer')
					const composerModel = composerCtrl?.model
					if (composerModel) {
						if (typeof composerModel.set === 'function') {
							composerModel.set('category', resolvedCategory)
							composerModel.set('categoryId', resolvedCategoryId)
						} else {
							composerModel.category = resolvedCategory
							composerModel.categoryId = resolvedCategoryId
						}
						if (composerCtrl?.setProperties) {
							composerCtrl.setProperties({ categoryId: resolvedCategoryId })
						}
					}
				} catch (composerError) {
					console.warn('Failed to push Docuss category onto composer model:', composerError)
				}

				console.debug('[Docuss] onSetRouteProps assigned category to composer', {
					requestedCategory: category,
					categoryId: resolvedCategoryId
				})
		} else if (category) {
			u.logError(`Category "${category}" not found in Discourse`)
		}
	}

	/**
   * @param {[Redirect]} redirects
   */
	onSetRedirects(redirects) {
		// Check redirects validity
		redirects.forEach(r => {
			const error = checkRedirect(r)
			u.throwIf(error, error)
		})

		// Remove previous redirects and store the new ones
		this.additionalRedirects = redirects

		// Perform immediate redirect if the current route matches a redirect rule.
		// This allows redirecting when loading the app on a wrong (non-redirected)
		// url
		const dest = getRedirectedRoute({ src: this.currentRoute, redirects })
		if (dest) {
			this._goToRouteFromClient({
				route: dest,
				mode: 'REPLACE',
				clientContext: null
			})
		}
	}

	/**
   * @param {CreateTagsParams} args
   */
	onCreateDcsTags(args) {
		log('onCreateDcsTags: ', arguments)

		const { pageName, triggerIds, notificationLevel } = args
		u.throwIfNot(pageName, 'postCreateDcsTags: missing argument "pageName"')

		console.log('[Docuss] onCreateDcsTags invoked', {
			pageName,
			triggerIds,
			notificationLevel
		})

		// Check page name existence
		const found = this.descrArray.find(
			d =>
				d.pages.find(p => p.name === pageName) ||
				(d.webApp && pageName.startsWith(d.webApp.otherPagesPrefix))
		)
		if (!found) {
			u.logError(`Unable to create tag: page "${pageName}" not found`)
			return
		}

		// Build the tag names
		const tags = triggerIds
			? triggerIds.map(triggerId => DcsTag.build({ pageName, triggerId }))
			: [DcsTag.build({ pageName, triggerId: undefined })]
		console.debug('[Docuss] onCreateDcsTags resolved tags', tags)

		const targetLevel =
			notificationLevel === undefined
				? NotificationLevels.WATCHING
				: notificationLevel
		const shouldSetNotifications =
			targetLevel !== undefined &&
			targetLevel !== NotificationLevels.REGULAR
		console.debug('[Docuss] onCreateDcsTags notification intent', {
			targetLevel,
			shouldSetNotifications
		})

		const applyNotificationLevel = () => {
			if (!shouldSetNotifications) {
				console.debug('[Docuss] onCreateDcsTags skipping notification level change')
				return Promise.resolve()
			}
			const tagsStr = JSON.stringify(tags)
			console.debug('[Docuss] onCreateDcsTags setting notification level', {
				targetLevel,
				tags
			})
			return u.async
				.forEach(tags, tag =>
					discourseAPI
						.setTagNotification({
						tag,
						notificationLevel: targetLevel
					})
					.then(() =>
						console.debug('[Docuss] setTagNotification success', {
							tag,
							notificationLevel: targetLevel
						})
					)
				)
				.catch(e => {
					u.logError(
						`Failed to set the notification level for one of those tags: ${tagsStr} (${e})`
					)
				})
		}

		// Create the tags, then ensure the creator follows them
		discourseAPI.newTags(tags).then(
			() => {
				console.debug('[Docuss] newTags success', { tags })
				return applyNotificationLevel()
			},
			e => {
				const tagsStr = JSON.stringify(tags)
				u.logError(`Failed to create tags ${tagsStr}: ${e}`)
				console.warn('[Docuss] newTags failed; attempting notification level anyway', {
					tags,
					error: e
				})
				return applyNotificationLevel()
			}
		)
	}

	/**
   * @param {CreateTopicParams} args
   */
	onCreateTopic(args) {
		log('onCreateTopic: ', arguments)

		const {
			title,
			body,
			category,
			pageName,
			triggerId,
			tagNotificationLevel
		} = args
		u.throwIfNot(pageName, 'postCreateTopic: missing argument "pageName"')

		// Check page name existence
		const found = this.descrArray.find(
			d =>
				d.pages.find(p => p.name === pageName) ||
				(d.webApp && pageName.startsWith(d.webApp.otherPagesPrefix))
		)
		if (!found) {
			u.logError(`Unable to create topic: page "${pageName}" not found`)
			return
		}

		// Build the tags
		const tag = DcsTag.build({ pageName, triggerId })
		const tags = [tag, 'dcs-discuss']
		console.log('[Docuss] onCreateTopic payload prepared', {
			title,
			category,
			pageName,
			triggerId,
			tags,
			targetLevelDefault: tagNotificationLevel
		})

		// Get the category id
		let catId = undefined
		if (category) {
			const appCtrl = this.container.lookup('controller:application')
			const cat = appCtrl.site.categories.find(c => c['name'] === category)
			if (!cat) {
				u.logError(`Unable to create topic: category "${category}" not found`)
				return
			}
			catId = cat['id']
		}

		const targetLevel =
			tagNotificationLevel === undefined
				? NotificationLevels.WATCHING
				: tagNotificationLevel

		const shouldSetTopicNotifications =
			targetLevel !== undefined &&
			targetLevel !== NotificationLevels.REGULAR
		console.debug('[Docuss] onCreateTopic notification intent', {
			targetLevel,
			shouldSetTopicNotifications
		})

		const createTopic = () => {
			console.debug('[Docuss] Now creating topic with tags', { tags })

			return discourseAPI.newTopic({ title, body, catId, tags }).then(
				createdPost => {
					if (!shouldSetTopicNotifications) {
						console.debug('[Docuss] onCreateTopic skipping notification setup')
						return createdPost
					}

					const notificationTags = ['dcs-discuss', tag]
					const tagPromises = notificationTags.map(notificationTag =>
						discourseAPI
							.setTagNotification({
								tag: notificationTag,
								notificationLevel: targetLevel
							})
							.catch(e => {
								u.logError(
									`Failed to set the notification level for tag ${notificationTag}: ${e}`
								)
							})
					)
					console.debug('[Docuss] onCreateTopic tag notifications requested', {
						notificationTags,
						targetLevel
					})

					const topicId = createdPost && createdPost['topic_id']
					if (topicId) {
						console.debug('[Docuss] onCreateTopic topic created', {
							topicId,
							notificationLevel: targetLevel
						})
						tagPromises.push(
							discourseAPI
								.setTopicNotification({
									topicId,
									notificationLevel: targetLevel
								})
								.catch(e => {
									u.logError(
										`Failed to set the notification level for topic ${topicId}: ${e}`
									)
								})
						)
					} else {
						u.logError('Failed to set the topic notification level: missing topic_id in response')
						console.warn('[Docuss] onCreateTopic missing topic_id in response', {
							createdPost
						})
					}

					return Promise.all(tagPromises).then(() => {
						console.debug('[Docuss] onCreateTopic notification promises resolved', {
							topicId,
							targetLevel
						})
						return createdPost
					})
				},
				e => {
					const tagsStr = JSON.stringify(tags)
					u.logError(`Failed to create topic with tags ${tagsStr}: ${e}`)
					console.error('[Docuss] onCreateTopic failed', {
						error: e,
						tags,
						title,
						pageName
					})
					throw e
				}
			)
		}

		// Pre-create tags if they don't exist yet
		// This uses the "create temporary topic" approach which works for all users
		// with "create tag allowed groups" permissions
		console.debug('[Docuss] Pre-creating tags if needed', { tags })
		const creationPromise = discourseAPI
			.newTags(tags)
			.then(
				() => {
					console.debug('[Docuss] Tag pre-creation succeeded or tags already exist')
					return createTopic()
				},
				e => {
					console.warn('[Docuss] Tag pre-creation failed, will try anyway during topic creation', e)
					return createTopic()
				}
			)

		this._trackTopicCreation(pageName, creationPromise)
	} // End of onCreateTopic

	_handleNavigateTo({ url, delay = 0, waitForPageName, waitTimeout }) {
		if (!url || typeof url !== 'string') {
			console.warn('[Docuss] navigateTo payload missing url', { url })
			return
		}

		const router = this.container.lookup('service:router')
		if (!router || typeof router.transitionTo !== 'function') {
			console.warn('[Docuss] Unable to locate router for navigateTo request')
			return
		}

		const runTransition = () => {
			if (delay > 0) {
				setTimeout(() => router.transitionTo(url), delay)
			} else {
				router.transitionTo(url)
			}
		}

		if (waitForPageName) {
			const effectiveTimeout =
				typeof waitTimeout === 'number'
					? waitTimeout
					: 8000
			const boundedTimeout = effectiveTimeout < 0 ? 0 : effectiveTimeout
			this._waitForTopicCreation(waitForPageName, boundedTimeout)
				.then(runTransition)
				.catch(() => runTransition())
			return
		}

		runTransition()
	}

	_trackTopicCreation(pageName, promise) {
		if (!pageName || !promise || typeof promise.then !== 'function') {
			return
		}

		const basePromise = Promise.resolve(promise)
		const safePromise = basePromise.catch(error => {
			console.error('[Docuss] Topic creation promise rejected', {
				pageName,
				error
			})
		})

		this.pendingTopicPromises.set(pageName, safePromise)

		if (typeof safePromise.finally === 'function') {
			safePromise.finally(() => {
				const stored = this.pendingTopicPromises.get(pageName)
				if (stored === safePromise) {
					this.pendingTopicPromises.delete(pageName)
				}
			})
		}
	}

	_waitForTopicCreation(pageName, timeoutMs = 8000) {
		const pending = pageName ? this.pendingTopicPromises.get(pageName) : null
		if (!pending) {
			return Promise.resolve()
		}

		const effectiveTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : 0

		return new Promise(resolve => {
			let finished = false
			const finish = () => {
				if (finished) {
					return
				}
				finished = true
				resolve()
			}

			const timeoutId = effectiveTimeout
				? setTimeout(() => {
					console.warn('[Docuss] Waiting for topic creation timed out', {
						pageName,
						timeoutMs: effectiveTimeout
					})
					finish()
				}, effectiveTimeout)
				: null

			pending
				.then(() => {
					if (timeoutId) {
						clearTimeout(timeoutId)
					}
					finish()
				})
				.catch(error => {
					if (timeoutId) {
						clearTimeout(timeoutId)
					}
					console.error('[Docuss] Topic creation promise rejected', {
						pageName,
						error
					})
					finish()
				})
		})
	}
} // End of DcsIFrame class

//------------------------------------------------------------------------------

// A note on transitionTo: providing both a path and a queryParams object
// doesn't work. You need to provide either a route name and a queryParams
// object OR a full path containing everything.

const get = url =>
	new Promise((resolve, reject) => {
		$.get(url, data => resolve(data)).fail(() => reject(`get "${url}" failed`))
	})

import { schedule } from '@ember/runloop'

	const afterRender = res =>
	  new Promise(resolve => {
		schedule('afterRender', null, () => resolve(res))
	  })

// Return null if "route" doesn't match one of the redirect rules
// Return the destination route if it does
function getRedirectedRoute({ src, redirects }) {
	const match = redirects.find(redirect => {
		const nonMatchingKeys = Object.keys(redirect.src).filter(key => {
			const wildcardRedirectSrc = redirect.src[key]
			if (
				typeof wildcardRedirectSrc === 'string' &&
				wildcardRedirectSrc.endsWith('*')
			) {
				return (
					!src[key] || !src[key].startsWith(wildcardRedirectSrc.slice(0, -1))
				)
			}
			return wildcardRedirectSrc !== src[key]
		})
		return nonMatchingKeys.length === 0
	})
	if (!match) {
		return null
	}

	const dest = Object.assign({}, match.dest)
	Object.keys(dest).forEach(key => {
		if (dest[key] === '@SAME_AS_SRC@') {
			dest[key] = src[key]
		}
	})

	return dest
}

//https://stackoverflow.com/questions/1787322/htmlspecialchars-equivalent-in-javascript/4835406#4835406
const map = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#039;'
}
const escapeHtml = text => text.replace(/[&<>"']/g, m => map[m])

function serializeCounts(counts) {
	return counts.map(c => {
		const { pageName, triggerId, count } = c
		return {
			['pageName']: pageName,
			['triggerId']: triggerId,
			['count']: count
		}
	})
}

//------------------------------------------------------------------------------
