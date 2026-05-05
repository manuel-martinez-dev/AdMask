export const FILTER_LIST_URLS = [
  "https://easylist.to/easylist/easylist.txt",
  "https://easylist.to/easylist/easyprivacy.txt",
  "https://easylist-downloads.adblockplus.org/abp-filters-anti-cv.txt",
];

export const REFRESH_INTERVAL_MINUTES = 10080;

export const BYPASS_HOSTNAMES = [
  "facebook.com",   // first-party ads; breaks with AdMask active
  "youtube.com",    // first-party ads via Google; heavy SPA
  "google.com",     // covers Docs, Sheets, Drive, Gmail, Search, etc.
];
