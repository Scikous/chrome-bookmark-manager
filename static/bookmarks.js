// --- UTILITY FUNCTIONS ---
function promisify(apiObject, methodNameString) {
    return function(...args) {
        return new Promise((resolve, reject) => {
            // Ensure the function is called with the correct 'this' context
            apiObject[methodNameString](...args, (result) => {
                if (chrome.runtime.lastError) {
                    const errorMessage = `Chrome API Error in ${methodNameString}: ${chrome.runtime.lastError.message}`;
                    console.error(errorMessage, chrome.runtime.lastError);
                    const error = new Error(errorMessage);
                    error.chromeErrorDetails = chrome.runtime.lastError; // Attach original error details
                    return reject(error);
                }
                resolve(result);
            });
        });
    };
}

// Promisified Chrome APIs
const getChildrenAsync = promisify(chrome.bookmarks, 'getChildren');
const searchBookmarksAsync = promisify(chrome.bookmarks, 'search');
const createBookmarkAsync = promisify(chrome.bookmarks, 'create');
const removeBookmarkAsync = promisify(chrome.bookmarks, 'remove');
const moveBookmarkAsync = promisify(chrome.bookmarks, 'move');
const getTreeAsync = promisify(chrome.bookmarks, 'getTree');
const queryTabsAsync = promisify(chrome.tabs, 'query');
const getStorageAsync = promisify(chrome.storage.sync, 'get');
const setStorageAsync = promisify(chrome.storage.sync, 'set');
const getLocalStorageAsync = promisify(chrome.storage.local, 'get');
const setLocalStorageAsync = promisify(chrome.storage.local, 'set');

// Helper function to display user feedback
function showFeedback(message, isError = false, duration = 3000) {
    const feedbackDiv = document.getElementById('saved');
    if (feedbackDiv) {
        feedbackDiv.textContent = message;
        feedbackDiv.className = isError ? 'feedback error' : 'feedback success';
        if (duration > 0) {
            setTimeout(() => {
                // Only clear if the message hasn't changed in the meantime
                if (feedbackDiv.textContent === message) {
                    feedbackDiv.textContent = '';
                    feedbackDiv.className = 'feedback';
                }
            }, duration);
        }
    }
    // Log errors to console as well
    if (isError) console.error("Feedback (Error):", message);
    else console.log("Feedback (Success):", message);
}

// --- CACHING CONSTANTS ---
const CACHE_KEY_FOLDERS = 'cachedFolderHierarchy';
const CACHE_KEY_TIMESTAMP = 'cachedFolderTimestamp';
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes cache duration

// --- CORE BOOKMARK LOGIC ---
let foldersLoaded = false; // Flag indicating if the main folder list has been loaded
let globalFlatFolderList = null; // Stores the flat list of all folders {id, title, depth}
let globalFolderTitleMap = null; // Stores a Map of folder ID -> folder title for quick lookups
let hasPopulatedBookmarkFolders = false; // Flag indicating if the second dropdown has been populated at least once

/**
 * Fetches the full bookmark folder hierarchy.
 * Uses chrome.bookmarks.getTree() for performance.
 * Implements caching using chrome.storage.local to avoid repeated slow fetches.
 * @param {boolean} forceRefresh - If true, bypasses cache and fetches fresh data.
 * @returns {Promise<Array<{id: string, title: string, depth: number}>>} - A promise resolving to the flat list of folders.
 */
async function getFullFolderHierarchy(forceRefresh = false) {
    // console.log(`%cgetFullFolderHierarchy CALLED. Force refresh: ${forceRefresh}`, 'color: blue; font-weight: bold;');
    let perfStartTotal = performance.now();

    // Attempt to load from cache unless forceRefresh is true
    if (!forceRefresh) {
        try {
            const cachedData = await getLocalStorageAsync([CACHE_KEY_FOLDERS, CACHE_KEY_TIMESTAMP]);
            const timestamp = cachedData[CACHE_KEY_TIMESTAMP];
            const foldersFromCache = cachedData[CACHE_KEY_FOLDERS];
            // console.log(`Cache check: timestamp = ${timestamp ? new Date(timestamp).toLocaleTimeString() : 'null'}, folders found = ${!!foldersFromCache}`);

            // Check if cache exists and is within the valid duration
            if (foldersFromCache && timestamp && (Date.now() - timestamp < CACHE_DURATION_MS)) {
                // console.log("%cLoading folder hierarchy from VALID cache.", 'color: green;');
                globalFlatFolderList = foldersFromCache;
                // Populate the global map from the cached list
                if (globalFlatFolderList && globalFlatFolderList.length > 0) {
                    globalFolderTitleMap = new Map(globalFlatFolderList.map(f => [f.id, f.title]));
                    // console.log("  Global folder title map CREATED/UPDATED from cache.");
                } else {
                    globalFolderTitleMap = new Map(); // Ensure it's initialized even if empty
                }
                // console.log(`getFullFolderHierarchy (total from cache) took ${performance.now() - perfStartTotal} ms.`);
                return globalFlatFolderList; // Return cached data
            } else if (foldersFromCache && timestamp) {
                console.log("%cCache EXPIRED, proceeding to refresh.", 'color: orange;');
            } else {
                console.log("%cNo valid cache found, proceeding to refresh.", 'color: orange;');
            }
        } catch (e) {
            console.error("Error reading from cache, proceeding to refresh:", e);
        }
    } else {
         console.log("%cForce refresh requested by caller.", 'color: magenta; font-weight: bold;');
    }

    // Cache miss, expiration, or forced refresh: Fetch fresh data
    console.log("Fetching FRESH full bookmark folder hierarchy using getTree()...");
    const allFoldersFlatList = []; // Array to hold the processed flat list

    // Recursive helper to process the bookmark tree nodes
    function processNodes(nodes, currentDepth) {
        if (!nodes) return; // Base case or empty children array

        // Ensure nodes is an array, filter out non-objects, and sort alphabetically by title
        const sortedNodes = Array.isArray(nodes) ?
            nodes.filter(node => typeof node === 'object' && node !== null)
                 .sort((a, b) => (a.title || "").localeCompare(b.title || ""))
            : [];

        // Iterate through sorted nodes at the current level
        for (const node of sortedNodes) {
            // Check if it's a folder (no URL property and has a title)
            if (!node.url && node.title) {
                allFoldersFlatList.push({ id: node.id, title: node.title, depth: currentDepth });
                // If the folder has children, recursively process them
                if (node.children && node.children.length > 0) {
                    processNodes(node.children, currentDepth + 1);
                }
            }
        }
    }

    let perfStartGetTree = performance.now();
    try {
        // Fetch the entire bookmark tree with a single API call
        const bookmarkTreeNodes = await getTreeAsync();
        console.log(`  chrome.bookmarks.getTree() call took ${performance.now() - perfStartGetTree} ms.`);

        if (!bookmarkTreeNodes || bookmarkTreeNodes.length === 0) {
            console.warn("  Bookmark tree is empty or could not be fetched.");
            globalFlatFolderList = []; globalFolderTitleMap = new Map(); return []; // Return empty state
        }

        // Process the tree starting from the children of the root node (usually ID '0')
        // let perfStartProcessNodes = performance.now();
        if (bookmarkTreeNodes[0] && bookmarkTreeNodes[0].children) {
            processNodes(bookmarkTreeNodes[0].children, 0); // Depth 0 for top-level display folders
        } else {
            console.warn("  Bookmark tree structure not as expected. Root children not found.");
        }
        // console.log(`  processNodes (sync traversal) took ${performance.now() - perfStartProcessNodes} ms.`);
        
        // Save the newly fetched flat list and timestamp to local storage cache
        await setLocalStorageAsync({
            [CACHE_KEY_FOLDERS]: allFoldersFlatList,
            [CACHE_KEY_TIMESTAMP]: Date.now()
        });
        console.log("%cFresh folder hierarchy saved to cache.", 'color: purple; font-weight: bold;');
        
        // Update global variables with the fresh data
        globalFlatFolderList = allFoldersFlatList;
        if (globalFlatFolderList && globalFlatFolderList.length > 0) {
            globalFolderTitleMap = new Map(globalFlatFolderList.map(f => [f.id, f.title]));
            // console.log("  Global folder title map CREATED/UPDATED from fresh fetch.");
        } else {
            globalFolderTitleMap = new Map();
        }
    } catch (error) {
        console.error("  Error fetching or processing bookmark tree:", error.message);
        showFeedback("Error loading folder hierarchy.", true);
        // console.log(`getFullFolderHierarchy (total with error) took ${performance.now() - perfStartTotal} ms.`);
        // Ensure globals are in a consistent empty state on error
        globalFlatFolderList = []; globalFolderTitleMap = new Map(); return [];
    }
    // console.log(`  Collected ${allFoldersFlatList.length} folders in total from the tree.`);
    // console.log(`getFullFolderHierarchy (total fresh fetch) took ${performance.now() - perfStartTotal} ms.`);
    return globalFlatFolderList; // Return the freshly fetched list
}

/**
 * Updates the main folder selection dropdown ('folderSelect') with the provided flat list.
 * @param {Array<{id: string, title: string, depth: number}>} flatFolderList - The list of folders to display.
 */
async function updateFolderSelect(flatFolderList) {
    // let perfStartTotal = performance.now();
    const select = document.getElementById('folderSelect');
    select.innerHTML = ''; // Clear previous options
    let optionsHTML = ''; // Build HTML string for better performance than appending nodes individually

    // let perfStartBuildHTML = performance.now();
    if (!flatFolderList || flatFolderList.length === 0) {
        optionsHTML = '<option value="" disabled selected>No folders found</option>';
    } else {
        // Generate <option> elements with indentation based on depth
        flatFolderList.forEach(folder => {
            const indent = ' '.repeat(folder.depth * 4); // 4 spaces per depth level
            // Use data-title for filtering (lowercase, no indentation)
            optionsHTML += `<option value="${folder.id}" data-title="${folder.title.toLowerCase()}">${indent}${folder.title}</option>`;
        });
    }
    // console.log(`  updateFolderSelect: Building HTML string took ${performance.now() - perfStartBuildHTML} ms.`);
    
    // Set the innerHTML once
    // let perfStartSetHTML = performance.now();
    select.innerHTML = optionsHTML;
    // console.log(`  updateFolderSelect: Setting innerHTML took ${performance.now() - perfStartSetHTML} ms.`);

    // Attempt to select the default folder stored in sync storage
    try {
        const storageResult = await getStorageAsync(['defaultFolderId']);
        const defaultFolderId = storageResult.defaultFolderId;
        if (defaultFolderId) {
            const defaultOption = select.querySelector(`option[value="${defaultFolderId}"]`);
            if (defaultOption) {
                defaultOption.selected = true; // Select the default option if found
            } else {
                 console.warn(`  Default folder ID ${defaultFolderId} not found in the dropdown (may have been deleted).`);
            }
        }
    } catch (storageError) {
        console.error("  Error getting default folder ID:", storageError.message);
    }

    foldersLoaded = true; // Mark main folders as loaded
    // console.log("  Folder select dropdown updated.");
    filterFolderOptions(); // Apply initial filter state
    // console.log(`  updateFolderSelect (total) took ${performance.now() - perfStartTotal} ms.`);
}

/**
 * Populates the second dropdown ('bookmarkFolderSelect') showing folders where the current page is bookmarked.
 * Uses the cached globalFolderTitleMap for efficiency.
 * Called lazily or when forced.
 * @param {boolean} forceRepopulate - If true, runs even if already populated.
 */
async function populateBookmarkFolderOptions(forceRepopulate = false) {
    // Exit early if already populated and not forced
    if (hasPopulatedBookmarkFolders && !forceRepopulate) {
        return;
    }
    hasPopulatedBookmarkFolders = false; // Reset flag, will be set to true on successful population

    // let perfStart = performance.now();
    const select = document.getElementById('bookmarkFolderSelect');
    select.innerHTML = '<option value="" disabled>Loading locations...</option>'; // Loading indicator

    // Check if the global map is ready (it should be if getFullFolderHierarchy ran successfully)
    if (!globalFolderTitleMap) {
        console.warn("  populateBookmarkFolderOptions: globalFolderTitleMap not available yet. Attempting to fetch main folder list first (this may indicate an issue if called too early).");
        await getFullFolderHierarchy(); // Try to ensure map is populated (should hit cache if main init was ok)
        if (!globalFolderTitleMap) { // Check again
             select.innerHTML = '<option value="" disabled>Folder data error</option>';
            //  console.log(`  populateBookmarkFolderOptions took ${performance.now() - perfStart} ms (globalFolderTitleMap still missing after retry).`);
             return;
        }
    }
    
    try {
        // Get current tab info
        const tabs = await queryTabsAsync({ active: true, currentWindow: true }); // Use active:true for this specific dropdown
        if (!tabs || tabs.length === 0) {
            select.innerHTML = '<option value="" disabled>No active tab</option>';
            // console.log(`  populateBookmarkFolderOptions took ${performance.now() - perfStart} ms (no active tab).`);
            return; // Cannot proceed without an active tab
        }
        const currentTab = tabs[0]; // This dropdown is for the single active tab
        const currentUrl = currentTab.url;

        // Validate URL (can't bookmark chrome:// pages etc.)
        if (!currentUrl || (!currentUrl.startsWith('http:') && !currentUrl.startsWith('https:'))) {
            select.innerHTML = '<option value="" disabled>Invalid tab URL</option>';
            // console.log(`  populateBookmarkFolderOptions took ${performance.now() - perfStart} ms (invalid URL).`);
            return;
        }

        // Find all bookmarks matching the current URL (this is fast)
        const bookmarks = await searchBookmarksAsync({ url: currentUrl });
        if (!bookmarks || bookmarks.length === 0) {
            select.innerHTML = '<option value="" disabled>Page not bookmarked</option>';
            // console.log(`  populateBookmarkFolderOptions took ${performance.now() - perfStart} ms (not bookmarked).`);
            hasPopulatedBookmarkFolders = true; // Mark as "populated" (with the 'not bookmarked' state)
            return;
        }

        // Get unique parent folder IDs (excluding root '0')
        const parentIds = new Set(bookmarks.map(b => b.parentId).filter(id => id && id !== '0'));
        if (parentIds.size === 0) {
            select.innerHTML = '<option value="" disabled>Not in any standard folder</option>';
            // console.log(`  populateBookmarkFolderOptions took ${performance.now() - perfStart} ms (no valid parent folders).`);
            hasPopulatedBookmarkFolders = true;
            return;
        }

        // Build options using the globalFolderTitleMap (fast lookup)
        let optionsHTML = '';
        let foundFoldersCount = 0;
        parentIds.forEach(parentId => {
            const folderTitle = globalFolderTitleMap.get(parentId); // Lookup title from map
            if (folderTitle) { 
                optionsHTML += `<option value="${parentId}">${folderTitle}</option>`;
                foundFoldersCount++;
            } else {
                // This folder exists as a parent but wasn't in our main hierarchy list
                // (could be root, 'Managed bookmarks', or an error case)
                console.warn(`  Parent folder ID ${parentId} for current tab's bookmark not found in globalFolderTitleMap.`);
            }
        });
        
        // Update the dropdown
        if (foundFoldersCount === 0) {
            select.innerHTML = '<option value="" disabled>No containing folders found</option>';
        } else {
             select.innerHTML = optionsHTML;
        }

        // Try to select the last folder this specific bookmark was interacted with (if stored)
        const storageResult = await getStorageAsync(['lastBookmarkedFolderID']);
        const lastFolderID = storageResult.lastBookmarkedFolderID;
        if (lastFolderID) {
            const lastOption = select.querySelector(`option[value="${lastFolderID}"]`);
            if (lastOption) lastOption.selected = true;
        } else if (select.options.length > 0 && select.options[0].value && !select.options[0].disabled) {
            // If no last folder known, select the first valid option
            select.selectedIndex = 0;
        }
        hasPopulatedBookmarkFolders = true; // Mark as successfully populated
    } catch (error) {
        console.error("  Error populating bookmark folder options:", error.message);
        select.innerHTML = '<option value="" disabled>Error loading</option>';
        showFeedback("Error populating bookmark's saved folders.", true, 0);
        hasPopulatedBookmarkFolders = false; // Mark as failed
    }
    // console.log(`  populateBookmarkFolderOptions (lazy/forced: ${forceRepopulate}) took ${performance.now() - perfStart} ms.`);
}

/**
 * Searches for bookmarks within the currently selected folder in the main dropdown.
 * Displays results in the 'folderBookmarks' dropdown.
 * If search input is empty, lists all bookmarks in the folder.
 */
async function searchBookmarkFolder() {
    const resultsSelect = document.getElementById('folderBookmarks');
    const folderSelect = document.getElementById('folderSelect');
    const searchInput = document.getElementById('searchInput');
    resultsSelect.innerHTML = ''; // Clear previous results

    if (!foldersLoaded) {
        showFeedback("Folders not loaded yet. Please wait.", true);
        resultsSelect.innerHTML = '<option value="" disabled>Folders loading...</option>';
        return;
    }

    const folderId = folderSelect.value;
    const folderOption = folderSelect.options[folderSelect.selectedIndex];
    // Get clean folder title from data attribute for display messages
    const folderTitle = folderOption ? folderOption.dataset.title : "Selected Folder"; 

    if (!folderId || (folderOption && folderOption.disabled)) {
        showFeedback("Please select a valid folder to search/list.", true);
        resultsSelect.innerHTML = '<option value="" disabled>Select a folder first</option>';
        return;
    }

    const searchTerm = searchInput.value.toLowerCase().trim();

    // Update status message based on whether searching or listing all
    if (searchTerm) {
        resultsSelect.innerHTML = `<option value="" disabled>Searching in '${folderTitle}' for "${searchTerm}"...</option>`;
    } else {
        resultsSelect.innerHTML = `<option value="" disabled>Listing all in '${folderTitle}'...</option>`;
    }

    try {
        // Get children of the selected folder
        const bookmarksInFolder = await getChildrenAsync(folderId);
        
        // Filter based on search term (if provided) or list all bookmarks
        const matchedBookmarks = searchTerm
            ? bookmarksInFolder.filter(bookmark =>
                bookmark.url && bookmark.title.toLowerCase().includes(searchTerm) // Match title
              )
            : bookmarksInFolder.filter(bookmark => bookmark.url); // List all actual bookmarks (with URL)

        // Handle no results
        if (matchedBookmarks.length === 0) {
            resultsSelect.innerHTML = searchTerm
                ? `<option value="" disabled>No matches for "${searchTerm}" in '${folderTitle}'</option>`
                : `<option value="" disabled>No bookmarks found in '${folderTitle}'</option>`;
            return;
        }

        // Build the results dropdown HTML
        const headerText = searchTerm
            ? `Found ${matchedBookmarks.length} in '${folderTitle}' for "${searchTerm}"`
            : `Listing ${matchedBookmarks.length} bookmarks in '${folderTitle}'`;

        let optionsHTML = `
            <option value="" disabled selected>${headerText}</option>
            <option value="ACTION_OPEN_ALL" data-action="open">Open All (${matchedBookmarks.length})</option>
            <option value="ACTION_DELETE_ALL" data-action="delete">Delete All (${matchedBookmarks.length})</option>
        `;
        matchedBookmarks.forEach(bookmark => {
            // Store URL in data attribute for opening/actions
            optionsHTML += `<option value="${bookmark.id}" data-url="${bookmark.url}">${bookmark.title}</option>`;
        });
        resultsSelect.innerHTML = optionsHTML; // Update dropdown content

        // Prepare data needed for the action monitor (Open All/Delete All)
        const detailsForMonitor = matchedBookmarks.map(b => ({id: b.id, url: b.url, title: b.title}));
        bkmOptionMonitor(resultsSelect, detailsForMonitor); // Attach event listener

    } catch (error) {
        console.error(`Error listing/searching folder ${folderId} ('${folderTitle}'):`, error.message);
        resultsSelect.innerHTML = `<option value="" disabled>Error accessing '${folderTitle}'</option>`;
        showFeedback(`Error accessing folder contents: ${error.message}`, true);
    }
}

/**
 * Attaches the change event listener to the 'folderBookmarks' dropdown
 * to handle opening single bookmarks or performing "Open All"/"Delete All" actions.
 * @param {HTMLSelectElement} selectElement - The dropdown element for search results.
 * @param {Array<{id: string, url: string, title: string}>} bookmarksDetails - Details of the listed bookmarks.
 */
function bkmOptionMonitor(selectElement, bookmarksDetails) { 
    selectElement.onchange = async function() { // Use async for potential awaits within actions
        const selectedOption = selectElement.options[selectElement.selectedIndex];
        const actionValue = selectedOption.value; 

        // Handle "Open All" or "Delete All" actions
        if (actionValue === "ACTION_OPEN_ALL" || actionValue === "ACTION_DELETE_ALL") {
            const isOpening = actionValue === "ACTION_OPEN_ALL";
            const confirmationMessage = isOpening ?
                `Open all ${bookmarksDetails.length} found bookmarks?` :
                `DELETE all ${bookmarksDetails.length} found bookmarks from this folder? This cannot be undone.`;

            // Confirm with the user
            if (confirm(confirmationMessage)) {
                let successCount = 0;
                // Iterate through the bookmarks that were found by the search/list
                for (const bkm of bookmarksDetails) {
                    try {
                        if (isOpening) {
                            chrome.tabs.create({ url: bkm.url, active: false }); // Open in background tab
                        } else {
                            await removeBookmarkAsync(bkm.id); // Delete the bookmark
                        }
                        successCount++;
                    } catch (err) {
                        console.error(`Error processing bookmark '${bkm.title}' (ID ${bkm.id}) for ${actionValue}:`, err.message);
                        showFeedback(`Error with '${bkm.title}': ${err.message}`, true);
                    }
                }
                showFeedback(`${isOpening ? 'Opened' : 'Deleted'} ${successCount}/${bookmarksDetails.length} bookmarks.`, false);

                // If bookmarks were deleted, refresh the search results and the second dropdown
                if (!isOpening) { 
                    await searchBookmarkFolder(); 
                    await populateBookmarkFolderOptions(true); // Force repopulate
                }
            }
            selectElement.selectedIndex = 0; 
        } 
        else if (selectedOption.dataset.url) {
            chrome.tabs.create({ url: selectedOption.dataset.url, active: true });
        }
    };
}

/**
 * Saves bookmarks for all highlighted tabs to the selected folder.
 */
async function saveBookmark() {
    const folderSelect = document.getElementById('folderSelect');
    const folderId = folderSelect.value;
    const folderOption = folderSelect.options[folderSelect.selectedIndex];
    const folderName = folderOption ? folderOption.dataset.title : "selected folder";

    if (!folderId || (folderOption && folderOption.disabled)) {
        showFeedback("No valid folder selected to save to.", true);
        return;
    }

    // let perfStart = performance.now();
    let successCount = 0;
    let alreadyExistsCount = 0;
    let errorCount = 0;
    let tabsToProcess = [];

    try {
        tabsToProcess = await queryTabsAsync({ highlighted: true, currentWindow: true });
        if (!tabsToProcess || tabsToProcess.length === 0) {
            showFeedback("No highlighted tabs found to save.", true); return;
        }

        for (const currentTab of tabsToProcess) {
            if (!currentTab.url || (!currentTab.url.startsWith('http:') && !currentTab.url.startsWith('https:'))) {
                 console.warn(`Cannot bookmark tab: ${currentTab.title || currentTab.id} (invalid URL: ${currentTab.url}). Skipping.`);
                 errorCount++;
                 continue;
            }
            
            try {
                const existingBookmarksForUrl = await searchBookmarksAsync({ url: currentTab.url });
                const alreadyExistsInTargetFolder = existingBookmarksForUrl.some(bm => bm.parentId === folderId);

                if (alreadyExistsInTargetFolder) {
                    console.log(`Tab '${currentTab.title || currentTab.url}' already bookmarked in '${folderName}'. Skipping.`);
                    alreadyExistsCount++;
                    continue; 
                }
                
                await createBookmarkAsync({
                    parentId: folderId,
                    title: currentTab.title || currentTab.url,
                    url: currentTab.url
                });
                successCount++;
                console.log(`Saved tab '${currentTab.title || currentTab.url}' to '${folderName}'.`);
            } catch (tabError) {
                console.error(`Error saving tab '${currentTab.title || currentTab.url}':`, tabError.message);
                errorCount++;
            }
        }

        let feedbackMessage = "";
        if (successCount > 0) feedbackMessage += `${successCount} bookmark(s) saved to '${folderName}'. `;
        if (alreadyExistsCount > 0) feedbackMessage += `${alreadyExistsCount} already existed. `;
        if (errorCount > 0) feedbackMessage += `${errorCount} failed.`;
        
        showFeedback(feedbackMessage.trim() || "No new bookmarks saved.", errorCount > 0 && successCount === 0);

        if (successCount > 0) {
            await setStorageAsync({ 'lastBookmarkedFolderID': folderId }); 
        }
        await populateBookmarkFolderOptions(true);
    } catch (error) {
        console.error("Error during batch save process:", error.message);
        showFeedback(`Error saving bookmarks: ${error.message}`, true);
    }
    // console.log(`saveBookmark (batch operation for ${tabsToProcess ? tabsToProcess.length : 0} tabs) took ${performance.now() - perfStart} ms.`);
}

/**
 * Sets the currently selected folder in the main dropdown as the default save location.
 */
async function setDefaultFolder() {
    const folderSelect = document.getElementById('folderSelect');
    const folderId = folderSelect.value;
    const folderOption = folderSelect.options[folderSelect.selectedIndex];
    const folderName = folderOption ? folderOption.dataset.title : "Selected folder";

    if (!folderId || (folderOption && folderOption.disabled)) {
        showFeedback("No valid folder selected as default.", true);
        return;
    }

    try {
        await setStorageAsync({ 'defaultFolderId': folderId }); 
        showFeedback(`'${folderName}' is now default.`, false);
    } catch (error) {
        console.error("Error setting default folder:", error.message);
        showFeedback(`Error setting default: ${error.message}`, true);
    }
}

/**
 * Deletes bookmarks for all highlighted tabs from the folder selected in the second dropdown.
 * No confirmation dialog.
 */
async function deleteBookmark() {
    const bookmarkFolderSelect = document.getElementById('bookmarkFolderSelect');

    // Step 1: Ensure dropdown has some state if possible to determine fromFolderId.
    if (bookmarkFolderSelect.options.length === 0 ||
        (bookmarkFolderSelect.options.length === 1 && bookmarkFolderSelect.options[0].disabled)) {
        console.log("deleteBookmark: bookmarkFolderSelect is completely empty. Populating before delete action...");
        await populateBookmarkFolderOptions(true);
        if (bookmarkFolderSelect.options.length === 0 || (bookmarkFolderSelect.options.length === 1 && bookmarkFolderSelect.options[0].disabled)) {
            showFeedback("Cannot determine folder to delete from; 'Bookmark's Saved Folders' is empty.", true);
            return;
        }
    }
    else if (!hasPopulatedBookmarkFolders) { 
        console.log("deleteBookmark: 'Bookmark's Saved Folders' potentially stale or uninitialized. Populating before delete action.");
        await populateBookmarkFolderOptions(true);
    }
    
    // Now, ensure there's a valid selection to act upon.
    if (!bookmarkFolderSelect.value || (bookmarkFolderSelect.options[bookmarkFolderSelect.selectedIndex] && bookmarkFolderSelect.options[bookmarkFolderSelect.selectedIndex].disabled)) {
        showFeedback("No valid folder selected in 'Bookmark's Saved Folders' to delete from.", true);
        return;
    }

    const fromFolderId = bookmarkFolderSelect.value;
    const fromFolderName = bookmarkFolderSelect.options[bookmarkFolderSelect.selectedIndex]?.text || "selected folder";

    console.log(`deleteBookmark: Proceeding to delete from folder: ${fromFolderName} (ID: ${fromFolderId}). NO CONFIRMATION.`);
    
    // Step 2: Proceed with delete for all highlighted tabs
    // let perfStartAction = performance.now();
    let successCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;
    let tabsToProcess = [];

    try {
        tabsToProcess = await queryTabsAsync({ highlighted: true, currentWindow: true });
        if (!tabsToProcess || tabsToProcess.length === 0) {
            showFeedback("No highlighted tabs found to delete bookmarks for.", true); return;
        }

        for (const currentTab of tabsToProcess) {
            if (!currentTab.url) { 
                console.warn(`Tab ${currentTab.id} has no URL. Skipping delete.`);
                errorCount++;
                continue;
            }
            
            try {
                const existingBookmarksForUrl = await searchBookmarksAsync({ url: currentTab.url });
                const bookmarkToDelete = existingBookmarksForUrl.find(b => b.parentId === fromFolderId);

                if (bookmarkToDelete) {
                    await removeBookmarkAsync(bookmarkToDelete.id);
                    successCount++;
                    console.log(`Deleted bookmark for '${currentTab.title || currentTab.url}' from '${fromFolderName}'.`);
                } else {
                    notFoundCount++;
                    console.log(`Bookmark for '${currentTab.title || currentTab.url}' not found in '${fromFolderName}'. Skipping.`);
                }
            } catch (tabError) {
                console.error(`Error deleting bookmark for tab '${currentTab.title || currentTab.url}':`, tabError.message);
                errorCount++;
            }
        }
        
        let feedbackMessage = "";
        if (successCount > 0) feedbackMessage += `${successCount} bookmark(s) deleted from '${fromFolderName}'. `;
        if (notFoundCount > 0) feedbackMessage += `${notFoundCount} not found. `;
        if (errorCount > 0) feedbackMessage += `${errorCount} failed.`;

        showFeedback(feedbackMessage.trim() || "No bookmarks processed for deletion.", errorCount > 0 && successCount === 0);
        await populateBookmarkFolderOptions(true); // Final populate to reflect deletion in UI
    } catch (error) { // Error from queryTabsAsync
        console.error("Error during batch delete process:", error.message);
        showFeedback(`Error deleting bookmarks: ${error.message}`, true);
    }
    // console.log(`deleteBookmark (batch operation for ${tabsToProcess ? tabsToProcess.length : 0} tabs) took ${performance.now() - perfStartAction} ms.`);
}

/**
 * Moves bookmarks for all highlighted tabs from the folder selected in the second dropdown
 * to the folder selected in the main dropdown.
 */
async function moveBookmark() {
    const fromFolderSelect = document.getElementById('bookmarkFolderSelect');
    const toFolderSelect = document.getElementById('folderSelect');

    // Step 1: Ensure 'from' dropdown has some state if possible.
    if (fromFolderSelect.options.length === 0 ||
        (fromFolderSelect.options.length === 1 && fromFolderSelect.options[0].disabled)) {
        console.log("moveBookmark: 'From' dropdown is completely empty. Populating before proceeding...");
        await populateBookmarkFolderOptions(true);
        if (fromFolderSelect.options.length === 0 || (fromFolderSelect.options.length === 1 && fromFolderSelect.options[0].disabled)) {
            showFeedback("Cannot determine 'from' folder; it's empty.", true);
            return;
        }
    } else if (!hasPopulatedBookmarkFolders) {
        console.log("moveBookmark: 'From' dropdown potentially stale. Populating before proceeding...");
        await populateBookmarkFolderOptions(true);
    }

    // Step 2: Validate selections
    if (!fromFolderSelect.value || (fromFolderSelect.options[fromFolderSelect.selectedIndex] && fromFolderSelect.options[fromFolderSelect.selectedIndex].disabled)) {
        showFeedback("No valid 'from' folder selected.", true); return;
    }
    const toFolderOption = toFolderSelect.options[toFolderSelect.selectedIndex];
    if (!toFolderSelect.value || (toFolderOption && toFolderOption.disabled)) {
        showFeedback("No valid 'to' folder selected.", true); return;
    }

    const fromFolderId = fromFolderSelect.value;
    const toFolderId = toFolderSelect.value;
    const fromFolderName = fromFolderSelect.options[fromFolderSelect.selectedIndex]?.text.trim() || "source";
    const toFolderName = toFolderOption?.dataset.title || "destination";

    if (fromFolderId === toFolderId) {
        showFeedback("Source and destination are same.", false); return;
    }
    
    // Step 3: Proceed with move for all highlighted tabs
    // let perfStartAction = performance.now();
    let successCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;
    let tabsToProcess = [];

    try {
        tabsToProcess = await queryTabsAsync({ highlighted: true, currentWindow: true });
        if (!tabsToProcess || tabsToProcess.length === 0) {
            showFeedback("No highlighted tabs found to move bookmarks for.", true); return;
        }

        for (const currentTab of tabsToProcess) {
            if (!currentTab.url) {
                console.warn(`Tab ${currentTab.id} has no URL. Skipping move.`);
                errorCount++;
                continue;
            }
            
            try {
                const existingBookmarksForUrl = await searchBookmarksAsync({ url: currentTab.url });
                const bookmarkToMove = existingBookmarksForUrl.find(b => b.parentId === fromFolderId);

                if (bookmarkToMove) {
                    await moveBookmarkAsync(bookmarkToMove.id, { parentId: toFolderId });
                    successCount++;
                    console.log(`Moved bookmark for '${currentTab.title || currentTab.url}' from '${fromFolderName}' to '${toFolderName}'.`);
                } else {
                    notFoundCount++;
                    console.log(`Bookmark for '${currentTab.title || currentTab.url}' not found in '${fromFolderName}'. Skipping move.`);
                }
            } catch (tabError) {
                console.error(`Error moving bookmark for tab '${currentTab.title || currentTab.url}':`, tabError.message, tabError.chromeErrorDetails);
                if (tabError.chromeErrorDetails?.message.toLowerCase().includes("can't move node into its own child")) {
                     showFeedback(`Cannot move '${currentTab.title || currentTab.url}' into its own subfolder.`, true, 5000);
                }
                errorCount++;
            }
        }

        let feedbackMessage = "";
        if (successCount > 0) feedbackMessage += `${successCount} bookmark(s) moved to '${toFolderName}'. `;
        if (notFoundCount > 0) feedbackMessage += `${notFoundCount} not found in '${fromFolderName}'. `;
        if (errorCount > 0) feedbackMessage += `${errorCount} failed.`;

        showFeedback(feedbackMessage.trim() || "No bookmarks processed for move.", errorCount > 0 && successCount === 0);
        await populateBookmarkFolderOptions(true); // Final populate
    } catch (error) { // Error from queryTabsAsync
        console.error("Error during batch move process:", error.message);
        showFeedback(`Error moving bookmarks: ${error.message}`, true);
    }
    // console.log(`moveBookmark (batch operation for ${tabsToProcess ? tabsToProcess.length : 0} tabs) took ${performance.now() - perfStartAction} ms.`);
}

/**
 * Debounce utility to limit how often a function can run.
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const context = this;
        const later = () => {
            timeout = null;
            func.apply(context, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Filters the options in the main folder dropdown based on the search input.
 */
function filterFolderOptions(isInitialCall = false) { // isInitialCall not actively used for optimization yet
    const searchInput = document.getElementById('searchInput');
    const filter = searchInput.value.toLowerCase().trim();
    const select = document.getElementById('folderSelect');
    const options = Array.from(select.options);

    const previouslySelectedValue = select.value;
    let firstVisibleSelectableValue = null;
    let isPreviouslySelectedOptionVisibleAndSelectable = false;

    options.forEach(option => {
        const isPlaceholderOrDisabled = option.disabled || option.value === "" || option.value.startsWith("ACTION_");
        
        if (isPlaceholderOrDisabled) {
            option.style.display = (filter === "" || (option.dataset.title && option.dataset.title.includes(filter))) ? '' : 'none';
            return;
        }

        const title = option.dataset.title; 
        const isVisible = title.includes(filter);
        option.style.display = isVisible ? '' : 'none';

        if (isVisible) {
            if (firstVisibleSelectableValue === null) firstVisibleSelectableValue = option.value;
            if (option.value === previouslySelectedValue) isPreviouslySelectedOptionVisibleAndSelectable = true;
        }
    });

    if (filter === "") {
        const previousOptionElement = select.querySelector(`option[value="${previouslySelectedValue}"]`);
        if (previousOptionElement && previousOptionElement.style.display !== 'none') {
            select.value = previouslySelectedValue;
        } else {
            const firstEnabledOption = options.find(opt => !opt.disabled && opt.style.display !== 'none' && opt.value);
            if (firstEnabledOption) select.value = firstEnabledOption.value;
        }
    } else {
        if (isPreviouslySelectedOptionVisibleAndSelectable) {
            select.value = previouslySelectedValue;
        } else if (firstVisibleSelectableValue) {
            select.value = firstVisibleSelectableValue;
        }
    }
}

/**
 * Handles chrome.bookmarks events. Since this extension doesn't modify folders,
 * this only resets the flag for the second dropdown to ensure it refreshes on next interaction.
 */
async function handleBookmarkChange(id, eventData) {
    // console.log(`%cBookmark event detected (ID: ${id}, Data: ${JSON.stringify(eventData)}). Resetting 'hasPopulatedBookmarkFolders' flag.`, 'color: steelblue;');
    if (hasPopulatedBookmarkFolders) {
        hasPopulatedBookmarkFolders = false;
        // console.log("  Flag 'hasPopulatedBookmarkFolders' reset. Second dropdown will repopulate on next interaction.");
    }
}

/**
 * Handles the click event for the manual refresh button.
 * Forces a refresh of the main folder list cache.
 */
async function manualRefreshFolders() {
    showFeedback("Refreshing folder list...", false, 0); // Show persistent feedback
    console.log("%cManual Refresh TRIGGERED", "background: yellow; color: black;");
    let refreshStart = performance.now();
    try {
        const allFoldersFlat = await getFullFolderHierarchy(true); // Force refresh
        await updateFolderSelect(allFoldersFlat); // Update main dropdown
        await populateBookmarkFolderOptions(true); // Force refresh second dropdown too
        
        showFeedback("Folder list refreshed!", false, 3000); // Success feedback
    } catch (error) {
        console.error("Error during manual folder refresh:", error);
        showFeedback("Error refreshing folder list.", true, 5000); // Error feedback
    }
    console.log(`Manual refresh process took ${performance.now() - refreshStart} ms.`);
}

// --- Main Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    let perfStartDOM = performance.now();
    console.log("DOM fully loaded and parsed");

    // Get references to DOM elements
    const folderSelect = document.getElementById('folderSelect');
    const searchInput = document.getElementById('searchInput');
    const bookmarkFolderSelectElement = document.getElementById('bookmarkFolderSelect');
    const refreshFoldersButton = document.getElementById('refreshFoldersButton');

    // Set initial states
    folderSelect.innerHTML = '<option value="" disabled selected>Loading folders...</option>';
    bookmarkFolderSelectElement.innerHTML = '<option value="" disabled selected>Current page locations</option>';

    // Helper to add click listeners
    const addClickListener = (id, handler) => {
        const element = document.getElementById(id);
        if (element) {
            element.addEventListener('click', async (event) => {
                // Automatically handle async/await for handlers
                if (handler.constructor.name === 'AsyncFunction') {
                    await handler(event);
                } else {
                    handler(event);
                }
            });
        } else {
            console.error(`Element '${id}' not found.`);
        }
    };

    // Attach listeners to buttons
    addClickListener('setDefaultButton', setDefaultFolder);
    addClickListener('searchFolder', searchBookmarkFolder);
    addClickListener('saveButton', saveBookmark);
    addClickListener('moveButton', moveBookmark);   
    addClickListener('deleteButton', deleteBookmark); 
    
    if (refreshFoldersButton) {
        refreshFoldersButton.addEventListener('click', manualRefreshFolders);
    } else {
        console.warn("Element with ID 'refreshFoldersButton' not found. Manual refresh disabled.");
    }

    // Lazy load second dropdown on focus
    if (bookmarkFolderSelectElement) {
        bookmarkFolderSelectElement.addEventListener('focus', async () => {
            if (!hasPopulatedBookmarkFolders) {
                console.log("Lazy loading for bookmarkFolderSelect focus: Populating 'Bookmark's Saved Folders'.");
                await populateBookmarkFolderOptions(true);
            }
        }); // Allow re-populating on focus if flag was reset
    }

    // Listener for folder filtering input
    if (searchInput) {
        searchInput.addEventListener('input', debounce(() => filterFolderOptions(false), 250));
    } else {
         console.warn("'searchInput' not found.");
    }
    
    console.log("Core event listeners attached.");

    // Set up listeners for bookmark changes to reset second dropdown state
    if (chrome.bookmarks.onCreated.hasListener(handleBookmarkChange)) { // Check if listeners exist before removing
        chrome.bookmarks.onCreated.removeListener(handleBookmarkChange);
        chrome.bookmarks.onRemoved.removeListener(handleBookmarkChange);
        chrome.bookmarks.onChanged.removeListener(handleBookmarkChange);
        chrome.bookmarks.onMoved.removeListener(handleBookmarkChange);
        console.log("Old bookmark change listeners REMOVED (if any).");
    }
    chrome.bookmarks.onCreated.addListener(handleBookmarkChange);
    chrome.bookmarks.onRemoved.addListener(handleBookmarkChange);
    chrome.bookmarks.onChanged.addListener(handleBookmarkChange);
    chrome.bookmarks.onMoved.addListener(handleBookmarkChange);
    console.log("Bookmark change listeners ADDED.");
    

    // Initial population of the main folder list
    try {
        const allFoldersFlat = await getFullFolderHierarchy(); // Uses cache if available
        await updateFolderSelect(allFoldersFlat);
        
        console.log("Primary folder list populated. Second dropdown (Bookmark's Saved Folders) will load lazily on interaction or if an action requires it.");

    } catch (error) {
        console.error("Error during initial setup:", error.message);
        folderSelect.innerHTML = '<option value="" disabled selected>Error loading folders</option>';
        showFeedback("Critical error during init. Check console.", true, 0);
    }
    console.log(`Initial setup (DOMContentLoaded) complete. Total time: ${performance.now() - perfStartDOM} ms.`);
});