// Plugins that only use fetch and pure code, so they run on desktop and phone alike.

export { a2aPlugin, type RemoteAgent, replyText } from "./a2a.js";
export { type CalendarEvent, type CalendarOptions, calendarPlugin, describeEvent, parseIcs } from "./calendar.js";
export { articleText, type Feed, NEWS_FEEDS, type NewsItem, type NewsOptions, newsPlugin, parseFeed } from "./news.js";
export {
  formatHits,
  formatPage,
  SEARCH,
  type SearchHit,
  type SearchOptions,
  type SearchProvider,
  type SearchService,
  searchPlugin,
  searchService,
  type WebPage,
} from "./search.js";
export {
  describeWeather,
  type Forecast,
  fetchForecast,
  needsUmbrella,
  type WeatherOptions,
  weatherPlugin,
} from "./weather.js";
