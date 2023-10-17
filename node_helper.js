const NodeHelper = require("node_helper");
const { google } = require("googleapis");
const { encodeQueryData } = require("./helpers");
const fs = require("fs");
const Log = require("logger");

const TOKEN_PATH = "/token.json";

module.exports = NodeHelper.create({
  // Override start method.
  start: function () {
    Log.log("Starting node helper for: " + this.name);
    this.isHelperActive = true;

    this.calendarService;
    this.config = {};
  },

  stop: function () {
    this.isHelperActive = false;
  },

  // Override socketNotificationReceived method.
  socketNotificationReceived: function (notification, payload) {

    Log.info(`Notification ${notification}`)

    switch (notification) {
      case "INIT":
        this.initializeAfterLoading(payload);
        break;

      case "MODULE_READY":
        if (!this.calendarService) {
          if (payload.queryParams) {
            // if payload is sent, user has authenticated
            const params = new URLSearchParams(payload.queryParams);
            this.authenticateWithQueryParams(params);
          } else {
            this.authenticate();
          }
        } else {
          this.sendSocketNotification("SERVICE_READY", {});
        }
        break;
      
      case "ADD_CALENDAR":
        this.fetchCalendar(
          payload.calendarID,
          payload.fetchInterval,
          payload.maximumEntries,
          payload.id
        );
        break;
    }
  },

  initializeAfterLoading: function (config) {
    this.config = config;

    Log.info(`Config loaded ${JSON.toString(config)}`)
  },

  authenticateWithQueryParams: function (params) {
    const error = params.get("error");
    if (error) {
      this.sendSocketNotification("AUTH_FAILED", { error_type: error });
      return;
    }

    var _this = this;
    const code = params.get("code");

    fs.readFile(_this.path + "/credentials.json", (err, content) => {
      if (err) {
        _this.sendSocketNotification("AUTH_FAILED", { error_type: err });
        return console.log("Error loading client secret file:", err);
      }
      // Authorize a client with credentials, then call the Google Tasks API.
      _this.authenticateWeb(
        _this,
        code,
        JSON.parse(content),
        _this.startCalendarService
      );
    });
  },

  // replaces the old authenticate method
  authenticateWeb: function (_this, code, credentials, callback) {
    const { client_secret, client_id, redirect_uris } = credentials.web;

    if (!client_secret || !client_id) {
      _this.sendSocketNotification("AUTH_FAILED", {
        error_type: "WRONG_CREDENTIALS_FORMAT"
      });
      return;
    }

    _this.oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris ? redirect_uris[0] : "http://localhost:8080"
    );

    _this.oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error("Error retrieving access token", err);
      _this.oAuth2Client.setCredentials(token);
      // Store the token to disk for later program executions
      fs.writeFile(_this.path + TOKEN_PATH, JSON.stringify(token), (err) => {
        if (err) return console.error(err);
        console.log("Token stored to", _this.path + TOKEN_PATH);
      });
      callback(_this.oAuth2Client, _this);
    });
  },

  // Authenticate oAuth credentials
  authenticate: function () {
    var _this = this;

    fs.readFile(_this.path + "/credentials.json", (err, content) => {
      if (err) {
        _this.sendSocketNotification("AUTH_FAILED", { error_type: err });
        return console.log("Error loading client secret file:", err);
      }
      // Authorize a client with credentials, then call the Google Tasks API.
      authorize(JSON.parse(content), _this.startCalendarService);
    });

    /**
     * Create an OAuth2 client with the given credentials, and then execute the
     * given callback function.
     * @param {Object} credentials The authorization client credentials.
     * @param {function} callback The callback to call with the authorized client.
     */
    function authorize(credentials, callback) {
      var creds;
      var credentialType;

      // TVs and Limited Input devices credentials
      if (credentials.installed) {
        creds = credentials.installed;
        credentialType = "tv";
      }

      // Web credentials (fallback)
      if (credentials.web) {
        creds = credentials.web;
        credentialType = "web";
      }

      const { client_secret, client_id, redirect_uris } = creds;

      if (!client_secret || !client_id) {
        _this.sendSocketNotification("AUTH_FAILED", {
          error_type: "WRONG_CREDENTIALS_FORMAT"
        });
        return;
      }

      _this.oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        redirect_uris ? redirect_uris[0] : "http://localhost:8080"
      );

      // Check if we have previously stored a token.
      fs.readFile(_this.path + TOKEN_PATH, (err, token) => {
        if (err) {
          const redirect_uri = redirect_uris
            ? redirect_uris[0]
            : `http://localhost:8080`;

          // alert auth is needed
          _this.sendSocketNotification("AUTH_NEEDED", {
            url: `https://accounts.google.com/o/oauth2/v2/auth?${encodeQueryData(
              {
                scope: "https://www.googleapis.com/auth/calendar.readonly",
                access_type: "offline",
                include_granted_scopes: true,
                response_type: "code",
                state: _this.name,
                redirect_uri,
                client_id
              }
            )}`, // only used for web credential
            credentialType
          });

          return console.log(
            this.name + ": Error loading token:",
            err,
            "Make sure you have authorized the app."
          );
        }
        _this.oAuth2Client.setCredentials(JSON.parse(token));
        callback(_this.oAuth2Client, _this);
      });
    }
  },

  /**
   * Check for data.error
   * @param {object} error
   */
  checkForHTTPError: function(request) {
	return request?.response?.data?.error?.toUpperCase();
  },

  startCalendarService: function (auth, _this) {
    _this.calendarService = google.calendar({ version: "v3", auth });
    _this.sendSocketNotification("SERVICE_READY", {});
  },

  /**
   * Fetch calendars
   *
   * @param {string} calendarID The ID of the calendar
   * @param {number} fetchInterval How often does the calendar needs to be fetched in ms
   * @param {number} maximumEntries The maximum number of events fetched.
   * @param {string} identifier ID of the module
   */
  fetchCalendar: function (
    calendarID,
    fetchInterval,
    maximumEntries,
    identifier
  ) {
    this.calendarService.events.list(
      {
        calendarId: calendarID,
        timeMin: new Date().toISOString(),
        maxResults: maximumEntries,
        singleEvents: true,
        orderBy: "startTime"
      },
      (err, res) => {
        if (err) {
          Log.error(
            "MMM-GoogleCalendar Error. Could not fetch calendar: ",
            calendarID,
            err
          );
          let error_type = NodeHelper.checkFetchError(err);
		  if (error_type === 'MODULE_ERROR_UNSPECIFIED') {
			  error_type = this.checkForHTTPError(err) || error_type;
		  }

		  // send error to module
          this.sendSocketNotification("CALENDAR_ERROR", {
            id: identifier,
            error_type
          });
        } else {
          const unfilteredEvents = res.data.items;

          Log.info(
            `${this.name}: ${unfilteredEvents.length} events loaded for ${calendarID}`
          );

          const filteredEvents = this.filterEvents(unfilteredEvents)

          Log.info(
            `${this.name}: ${filteredEvents.length} events after filtering for ${calendarID}`
          );

          this.broadcastEvents(filteredEvents, identifier, calendarID); 
        }
        
        this.scheduleNextCalendarFetch(
          calendarID,
          fetchInterval,
          maximumEntries,
          identifier
        );
      }
    );
  },

  filterEvents: function(events, config) {

    return events.filter(event => { return !this.filterByTitle(event) })
  },

  filterByTitle: function(event) {

    const {
      excludedEvents
    } = this.config

    const title = event.summary;
    Log.debug(`title: ${title}`);

    let excluded = false,
      dateFilter = null;

    for (let f in excludedEvents) {
      let filter =excludedEvents[f],
        testTitle = title.toLowerCase(),
        until = null,
        useRegex = false,
        regexFlags = "g";

      if (filter instanceof Object) {
        if (typeof filter.until !== "undefined") {
          until = filter.until;
        }

        if (typeof filter.regex !== "undefined") {
          useRegex = filter.regex;
        }

        // If additional advanced filtering is added in, this section
        // must remain last as we overwrite the filter object with the
        // filterBy string
        if (filter.caseSensitive) {
          filter = filter.filterBy;
          testTitle = title;
        } else if (useRegex) {
          filter = filter.filterBy;
          testTitle = title;
          regexFlags += "i";
        } else {
          filter = filter.filterBy.toLowerCase();
        }
      } else {
        filter = filter.toLowerCase();
      }

      if (this.titleFilterApplies(testTitle, filter, useRegex, regexFlags)) {
        if (until) {
          dateFilter = until;
        } else {
          Log.info(`Filter event ${testTitle}`)
          excluded = true;
        }
        break;
      }
    }

    return excluded
  },

  /**
	 * Determines if the user defined title filter should apply
	 * @param {string} title the title of the event
	 * @param {string} filter the string to look for, can be a regex also
	 * @param {boolean} useRegex true if a regex should be used, otherwise it just looks for the filter as a string
	 * @param {string} regexFlags flags that should be applied to the regex
	 * @returns {boolean} True if the title should be filtered out, false otherwise
	 */
	titleFilterApplies: function (title, filter, useRegex, regexFlags) {
		if (useRegex) {
			let regexFilter = filter;
			// Assume if leading slash, there is also trailing slash
			if (filter[0] === "/") {
				// Strip leading and trailing slashes
				regexFilter = filter.substr(1).slice(0, -1);
			}
			return new RegExp(regexFilter, regexFlags).test(title);
		} else {
			return title.includes(filter);
		}
	},

  scheduleNextCalendarFetch: function (
    calendarID,
    fetchInterval,
    maximumEntries,
    identifier
  ) {
    var _this = this;
    if (this.isHelperActive) {
      setTimeout(function () {
        _this.fetchCalendar(
          calendarID,
          fetchInterval,
          maximumEntries,
          identifier
        );
      }, fetchInterval);
    }
  },

  broadcastEvents: function (events, identifier, calendarID) {
    this.sendSocketNotification("CALENDAR_EVENTS", {
      id: identifier,
      calendarID,
      events: events
    });
  }
});
