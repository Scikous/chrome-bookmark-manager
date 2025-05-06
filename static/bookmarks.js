// --- UTILITY FUNCTIONS ---
function promisify(apiObject, methodNameString) {
    return function(...args) {
        return new Promise((resolve, reject) => {
            apiObject[methodNameString](...args, (result) => {
                if (chrome.runtime.lastError) {
                    const errorMessage = `Chrome API Error in ${methodNameString}: ${chrome.runtime.lastError.message}`;
                    console.error(errorMessage, chrome.runtime.lastError);
                    const error = new Error(errorMessage);
                    error.chromeErrorDetails = chrome.runtime.lastError;
                    return reject(error);
                }
                resolve(result);
            });
        });
    };
}

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

function showFeedback(message, isError = false, duration = 3000) {
    const feedbackDiv = document.getElementById('saved');
    if (feedbackDiv) {
        feedbackDiv.textContent = message;
        feedbackDiv.className = isError ? 'feedback error' : 'feedback success';
        if (duration > 0) {
            setTimeout(() => {
                if (feedbackDiv.textContent === message) {
                    feedbackDiv.textContent = '';
                    feedbackDiv.className = 'feedback';
                }
            }, duration);
        }
    }
    if (isError) console.error("Feedback (Error):", message);
    else console.log("Feedback (Success):", message);
}

// --- CACHING CONSTANTS ---
const CACHE_KEY_FOLDERS = 'cachedFolderHierarchy';
const CACHE_KEY_TIMESTAMP = 'cachedFolderTimestamp';
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// --- CORE BOOKMARK LOGIC ---
let foldersLoaded = false;
let globalFlatFolderList = null;
let globalFolderTitleMap = null;
let hasPopulatedBookmarkFolders = false;

async function getFullFolderHierarchy(forceRefresh = false) {
    console.log(`%cgetFullFolderHierarchy CALLED. Force refresh: ${forceRefresh}`, 'color: blue; font-weight: bold;');
    let perfStartTotal = performance.now();

    if (!forceRefresh) {
        try {
            const cachedData = await getLocalStorageAsync([CACHE_KEY_FOLDERS, CACHE_KEY_TIMESTAMP]);
            const timestamp = cachedData[CACHE_KEY_TIMESTAMP];
            const foldersFromCache = cachedData[CACHE_KEY_FOLDERS];
            console.log(`Cache check: timestamp = ${timestamp ? new Date(timestamp).toLocaleTimeString() : 'null'}, folders found = ${!!foldersFromCache}`);

            if (foldersFromCache && timestamp && (Date.now() - timestamp < CACHE_DURATION_MS)) {
                console.log("%cLoading folder hierarchy from VALID cache.", 'color: green;');
                globalFlatFolderList = foldersFromCache;
                if (globalFlatFolderList && globalFlatFolderList.length > 0) {
                    globalFolderTitleMap = new Map(globalFlatFolderList.map(f => [f.id, f.title]));
                    console.log("  Global folder title map CREATED/UPDATED from cache.");
                } else {
                    globalFolderTitleMap = new Map();
                }
                console.log(`getFullFolderHierarchy (total from cache) took ${performance.now() - perfStartTotal} ms.`);
                return globalFlatFolderList;
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

    console.log("Fetching FRESH full bookmark folder hierarchy using getTree()...");
    const allFoldersFlatList = [];
    function processNodes(nodes, currentDepth) {
        if (!nodes) return;
        const sortedNodes = Array.isArray(nodes) ?
            nodes.filter(node => typeof node === 'object' && node !== null)
                 .sort((a, b) => (a.title || "").localeCompare(b.title || ""))
            : [];
        for (const node of sortedNodes) {
            if (!node.url && node.title) { // It's a folder
                allFoldersFlatList.push({ id: node.id, title: node.title, depth: currentDepth });
                if (node.children && node.children.length > 0) {
                    processNodes(node.children, currentDepth + 1);
                }
            }
        }
    }
    let perfStartGetTree = performance.now();
    try {
        const bookmarkTreeNodes = await getTreeAsync();
        console.log(`  chrome.bookmarks.getTree() call took ${performance.now() - perfStartGetTree} ms.`);
        if (!bookmarkTreeNodes || bookmarkTreeNodes.length === 0) {
            console.warn("  Bookmark tree is empty or could not be fetched.");
            globalFlatFolderList = []; globalFolderTitleMap = new Map(); return [];
        }
        let perfStartProcessNodes = performance.now();
        if (bookmarkTreeNodes[0] && bookmarkTreeNodes[0].children) {
            processNodes(bookmarkTreeNodes[0].children, 0);
        } else {
            console.warn("  Bookmark tree structure not as expected. Root children not found.");
        }
        console.log(`  processNodes (sync traversal) took ${performance.now() - perfStartProcessNodes} ms.`);
        
        await setLocalStorageAsync({
            [CACHE_KEY_FOLDERS]: allFoldersFlatList,
            [CACHE_KEY_TIMESTAMP]: Date.now()
        });
        console.log("%cFresh folder hierarchy saved to cache.", 'color: purple; font-weight: bold;');
        
        globalFlatFolderList = allFoldersFlatList;
        if (globalFlatFolderList && globalFlatFolderList.length > 0) {
            globalFolderTitleMap = new Map(globalFlatFolderList.map(f => [f.id, f.title]));
            console.log("  Global folder title map CREATED/UPDATED from fresh fetch.");
        } else {
            globalFolderTitleMap = new Map();
        }
    } catch (error) {
        console.error("  Error fetching or processing bookmark tree:", error.message);
        showFeedback("Error loading folder hierarchy.", true);
        console.log(`getFullFolderHierarchy (total with error) took ${performance.now() - perfStartTotal} ms.`);
        globalFlatFolderList = []; globalFolderTitleMap = new Map(); return [];
    }
    console.log(`  Collected ${allFoldersFlatList.length} folders in total from the tree.`);
    console.log(`getFullFolderHierarchy (total fresh fetch) took ${performance.now() - perfStartTotal} ms.`);
    return globalFlatFolderList;
}

async function updateFolderSelect(flatFolderList) {
    let perfStartTotal = performance.now();
    const select = document.getElementById('folderSelect');
    select.innerHTML = '';
    let optionsHTML = '';

    let perfStartBuildHTML = performance.now();
    if (!flatFolderList || flatFolderList.length === 0) {
        optionsHTML = '<option value="" disabled selected>No folders found</option>';
    } else {
        flatFolderList.forEach(folder => {
            const indent = ' '.repeat(folder.depth * 4);
            optionsHTML += `<option value="${folder.id}" data-title="${folder.title.toLowerCase()}">${indent}${folder.title}</option>`;
        });
    }
    console.log(`  updateFolderSelect: Building HTML string took ${performance.now() - perfStartBuildHTML} ms.`);
    
    let perfStartSetHTML = performance.now();
    select.innerHTML = optionsHTML;
    console.log(`  updateFolderSelect: Setting innerHTML took ${performance.now() - perfStartSetHTML} ms.`);

    try {
        const storageResult = await getStorageAsync(['defaultFolderId']);
        const defaultFolderId = storageResult.defaultFolderId;
        if (defaultFolderId) {
            const defaultOption = select.querySelector(`option[value="${defaultFolderId}"]`);
            if (defaultOption) defaultOption.selected = true;
            else console.warn(`  Default folder ID ${defaultFolderId} not found.`);
        }
    } catch (storageError) {
        console.error("  Error getting default folder ID:", storageError.message);
    }
    foldersLoaded = true;
    console.log("  Folder select dropdown updated.");
    filterFolderOptions();
    console.log(`  updateFolderSelect (total) took ${performance.now() - perfStartTotal} ms.`);
}

async function populateBookmarkFolderOptions(forceRepopulate = false) {
    if (hasPopulatedBookmarkFolders && !forceRepopulate) {
        return;
    }
    hasPopulatedBookmarkFolders = false;

    let perfStart = performance.now();
    const select = document.getElementById('bookmarkFolderSelect');
    select.innerHTML = '<option value="" disabled>Loading locations...</option>';

    if (!globalFolderTitleMap) {
        console.warn("  populateBookmarkFolderOptions: globalFolderTitleMap not available yet. Attempting to fetch main folder list first (this may indicate an issue if called too early).");
        await getFullFolderHierarchy(); 
        if (!globalFolderTitleMap) {
             select.innerHTML = '<option value="" disabled>Folder data error</option>';
             console.log(`  populateBookmarkFolderOptions took ${performance.now() - perfStart} ms (globalFolderTitleMap still missing after retry).`);
             return;
        }
    }
    
    try {
        const tabs = await queryTabsAsync({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            select.innerHTML = '<option value="" disabled>No active tab</option>';
            console.log(`  populateBookmarkFolderOptions took ${performance.now() - perfStart} ms (no active tab).`);
            return;
        }
        const currentTab = tabs[0];
        const currentUrl = currentTab.url;

        if (!currentUrl || (!currentUrl.startsWith('http:') && !currentUrl.startsWith('https:'))) {
            select.innerHTML = '<option value="" disabled>Invalid tab URL</option>';
            console.log(`  populateBookmarkFolderOptions took ${performance.now() - perfStart} ms (invalid URL).`);
            return;
        }

        const bookmarks = await searchBookmarksAsync({ url: currentUrl });
        if (!bookmarks || bookmarks.length === 0) {
            select.innerHTML = '<option value="" disabled>Page not bookmarked</option>';
            console.log(`  populateBookmarkFolderOptions took ${performance.now() - perfStart} ms (not bookmarked).`);
            hasPopulatedBookmarkFolders = true;
            return;
        }

        const parentIds = new Set(bookmarks.map(b => b.parentId).filter(id => id && id !== '0'));
        if (parentIds.size === 0) {
            select.innerHTML = '<option value="" disabled>No containing folders</option>';
            console.log(`  populateBookmarkFolderOptions took ${performance.now() - perfStart} ms (no parent folders).`);
            hasPopulatedBookmarkFolders = true;
            return;
        }

        let optionsHTML = '';
        let foundFoldersCount = 0;
        parentIds.forEach(parentId => {
            const folderTitle = globalFolderTitleMap.get(parentId);
            if (folderTitle) { 
                optionsHTML += `<option value="${parentId}">${folderTitle}</option>`;
                foundFoldersCount++;
            } else {
                console.warn(`  Parent folder ID ${parentId} for current tab's bookmark not found in globalFolderTitleMap (it might be the root or an inaccessible folder).`);
            }
        });
        
        if (foundFoldersCount === 0) {
            select.innerHTML = '<option value="" disabled>No containing folders found</option>';
        } else {
             select.innerHTML = optionsHTML;
        }

        const storageResult = await getStorageAsync(['lastBookmarkedFolderID']);
        const lastFolderID = storageResult.lastBookmarkedFolderID;
        if (lastFolderID) {
            const lastOption = select.querySelector(`option[value="${lastFolderID}"]`);
            if (lastOption) lastOption.selected = true;
        } else if (select.options.length > 0 && select.options[0].value && !select.options[0].disabled) {
            select.selectedIndex = 0;
        }
        hasPopulatedBookmarkFolders = true;
    } catch (error) {
        console.error("  Error populating bookmark folder options:", error.message);
        select.innerHTML = '<option value="" disabled>Error loading</option>';
        showFeedback("Error populating bookmark's saved folders.", true, 0);
        hasPopulatedBookmarkFolders = false;
    }
    console.log(`  populateBookmarkFolderOptions (lazy/forced: ${forceRepopulate}) took ${performance.now() - perfStart} ms.`);
}

async function searchBookmarkFolder() {
    const resultsSelect = document.getElementById('folderBookmarks');
    const folderSelect = document.getElementById('folderSelect');
    const searchInput = document.getElementById('searchInput');
    resultsSelect.innerHTML = '';

    if (!foldersLoaded) {
        showFeedback("Folders not loaded yet. Please wait.", true);
        resultsSelect.innerHTML = '<option value="" disabled>Folders loading...</option>';
        return;
    }

    const folderId = folderSelect.value;
    const folderOption = folderSelect.options[folderSelect.selectedIndex];
    const folderTitle = folderOption ? folderOption.dataset.title : "Selected Folder";

    if (!folderId || (folderOption && folderOption.disabled)) {
        showFeedback("Please select a valid folder to search/list.", true);
        resultsSelect.innerHTML = '<option value="" disabled>Select a folder first</option>';
        return;
    }

    const searchTerm = searchInput.value.toLowerCase().trim();

    if (searchTerm) {
        resultsSelect.innerHTML = `<option value="" disabled>Searching in '${folderTitle}' for "${searchTerm}"...</option>`;
    } else {
        resultsSelect.innerHTML = `<option value="" disabled>Listing all in '${folderTitle}'...</option>`;
    }

    try {
        const bookmarksInFolder = await getChildrenAsync(folderId);
        const matchedBookmarks = searchTerm
            ? bookmarksInFolder.filter(bookmark =>
                bookmark.url && bookmark.title.toLowerCase().includes(searchTerm)
              )
            : bookmarksInFolder.filter(bookmark => bookmark.url);

        if (matchedBookmarks.length === 0) {
            resultsSelect.innerHTML = searchTerm
                ? `<option value="" disabled>No matches for "${searchTerm}" in '${folderTitle}'</option>`
                : `<option value="" disabled>No bookmarks found in '${folderTitle}'</option>`;
            return;
        }

        const headerText = searchTerm
            ? `Found ${matchedBookmarks.length} in '${folderTitle}' for "${searchTerm}"`
            : `Listing ${matchedBookmarks.length} bookmarks in '${folderTitle}'`;

        let optionsHTML = `
            <option value="" disabled selected>${headerText}</option>
            <option value="ACTION_OPEN_ALL" data-action="open">Open All (${matchedBookmarks.length})</option>
            <option value="ACTION_DELETE_ALL" data-action="delete">Delete All (${matchedBookmarks.length})</option>
        `;
        matchedBookmarks.forEach(bookmark => {
            optionsHTML += `<option value="${bookmark.id}" data-url="${bookmark.url}">${bookmark.title}</option>`;
        });
        resultsSelect.innerHTML = optionsHTML;
        const detailsForMonitor = matchedBookmarks.map(b => ({id: b.id, url: b.url, title: b.title}));
        bkmOptionMonitor(resultsSelect, detailsForMonitor);

    } catch (error) {
        console.error(`Error listing/searching folder ${folderId} ('${folderTitle}'):`, error.message);
        resultsSelect.innerHTML = `<option value="" disabled>Error accessing '${folderTitle}'</option>`;
        showFeedback(`Error accessing folder contents: ${error.message}`, true);
    }
}

function bkmOptionMonitor(selectElement, bookmarksDetails) { 
    selectElement.onchange = async function() { 
        const selectedOption = selectElement.options[selectElement.selectedIndex];
        const actionValue = selectedOption.value; 

        if (actionValue === "ACTION_OPEN_ALL" || actionValue === "ACTION_DELETE_ALL") {
            const isOpening = actionValue === "ACTION_OPEN_ALL";
            const confirmationMessage = isOpening ?
                `Open all ${bookmarksDetails.length} found bookmarks?` :
                `DELETE all ${bookmarksDetails.length} found bookmarks from this folder? This cannot be undone.`;

            if (confirm(confirmationMessage)) {
                let successCount = 0;
                for (const bkm of bookmarksDetails) {
                    try {
                        if (isOpening) {
                            chrome.tabs.create({ url: bkm.url, active: false });
                        } else {
                            await removeBookmarkAsync(bkm.id);
                        }
                        successCount++;
                    } catch (err) {
                        console.error(`Error processing bookmark '${bkm.title}' (ID ${bkm.id}) for ${actionValue}:`, err.message);
                        showFeedback(`Error with '${bkm.title}': ${err.message}`, true);
                    }
                }
                showFeedback(`${isOpening ? 'Opened' : 'Deleted'} ${successCount}/${bookmarksDetails.length} bookmarks.`, false);

                if (!isOpening) { 
                    await searchBookmarkFolder(); 
                    await populateBookmarkFolderOptions(true);
                }
            }
            selectElement.selectedIndex = 0;
        } else if (selectedOption.dataset.url) {
            chrome.tabs.create({ url: selectedOption.dataset.url, active: true });
        }
    };
}

async function saveBookmark() {
    const folderSelect = document.getElementById('folderSelect');
    const folderId = folderSelect.value;
    const folderOption = folderSelect.options[folderSelect.selectedIndex];
    const folderName = folderOption ? folderOption.dataset.title : "selected folder";

    if (!folderId || (folderOption && folderOption.disabled)) {
        showFeedback("No valid folder selected to save to.", true);
        return;
    }

    try {
        const tabs = await queryTabsAsync({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            showFeedback("No active tab found to save.", true);
            return;
        }
        const currentTab = tabs[0];
        if (!currentTab.url || (!currentTab.url.startsWith('http:') && !currentTab.url.startsWith('https:'))) {
             showFeedback("Cannot bookmark this page.", true);
             return;
        }
        
        const existingBookmarksInFolder = await getChildrenAsync(folderId);
        const alreadyExists = existingBookmarksInFolder.some(bm => bm.url === currentTab.url);

        if (alreadyExists) {
            showFeedback(`Page already bookmarked in '${folderName}'.`, false);
            return;
        }
        
        await createBookmarkAsync({
            parentId: folderId,
            title: currentTab.title || currentTab.url,
            url: currentTab.url
        });

        showFeedback(`Bookmark saved to '${folderName}'!`, false);
        await setStorageAsync({ 'lastBookmarkedFolderID': folderId }); 
        await populateBookmarkFolderOptions(true);
    } catch (error) {
        console.error("Error saving bookmark:", error.message);
        showFeedback(`Error saving bookmark: ${error.message}`, true);
    }
}

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

async function deleteBookmark() {
    const bookmarkFolderSelect = document.getElementById('bookmarkFolderSelect');
    if (!bookmarkFolderSelect || bookmarkFolderSelect.options.length === 0 || !bookmarkFolderSelect.value || bookmarkFolderSelect.options[bookmarkFolderSelect.selectedIndex].disabled) {
        showFeedback("No bookmark/folder selected to delete from.", true);
        return;
    }
    const fromFolderId = bookmarkFolderSelect.value;
    const fromFolderName = bookmarkFolderSelect.options[bookmarkFolderSelect.selectedIndex]?.text || "selected folder";

    if (!confirm(`Delete bookmark for current page from '${fromFolderName}'?`)) return;

    try {
        const tabs = await queryTabsAsync({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            showFeedback("No active tab found.", true); return;
        }
        const currentTab = tabs[0];
        const currentUrl = currentTab.url;
        if (!currentUrl) { 
            showFeedback("Active tab has no URL.", true); return;
        }
        
        const bookmarksInParentFolder = await getChildrenAsync(fromFolderId);
        const bookmarkToDelete = bookmarksInParentFolder.find(b => b.url === currentUrl);

        if (bookmarkToDelete) {
            await removeBookmarkAsync(bookmarkToDelete.id);
            showFeedback(`Bookmark deleted from '${fromFolderName}'.`, false);
            await populateBookmarkFolderOptions(true);
        } else {
            showFeedback(`Bookmark not found in '${fromFolderName}'.`, false);
        }
    } catch (error) {
        console.error("Error deleting bookmark:", error.message);
        showFeedback(`Error deleting: ${error.message}`, true);
    }
}

async function moveBookmark() {
    const fromFolderSelect = document.getElementById('bookmarkFolderSelect');
    const toFolderSelect = document.getElementById('folderSelect');

    if (!fromFolderSelect || fromFolderSelect.options.length === 0 || !fromFolderSelect.value || fromFolderSelect.options[fromFolderSelect.selectedIndex].disabled) {
        showFeedback("No valid 'from' folder selected.", true); return;
    }
    const toFolderOption = toFolderSelect.options[toFolderSelect.selectedIndex];
    if (!toFolderSelect || !toFolderSelect.value || (toFolderOption && toFolderOption.disabled)) {
        showFeedback("No valid 'to' folder selected.", true); return;
    }

    const fromFolderId = fromFolderSelect.value;
    const toFolderId = toFolderSelect.value;
    const fromFolderName = fromFolderSelect.options[fromFolderSelect.selectedIndex]?.text.trim() || "source";
    const toFolderName = toFolderOption?.dataset.title || "destination";

    if (fromFolderId === toFolderId) {
        showFeedback("Source and destination are same.", false); return;
    }

    try {
        const tabs = await queryTabsAsync({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            showFeedback("No active tab for bookmark move.", true); return;
        }
        const currentTab = tabs[0];
        const currentUrl = currentTab.url;
        if (!currentUrl) {
            showFeedback("Active tab has no URL.", true); return;
        }
        
        const bookmarksInSourceFolder = await getChildrenAsync(fromFolderId);
        const bookmarkToMove = bookmarksInSourceFolder.find(b => b.url === currentUrl);

        if (bookmarkToMove) {
            await moveBookmarkAsync(bookmarkToMove.id, { parentId: toFolderId });
            showFeedback(`Moved from '${fromFolderName}' to '${toFolderName}'.`, false);
            await populateBookmarkFolderOptions(true);
        } else {
            showFeedback(`Bookmark not in '${fromFolderName}' to move.`, false);
        }
    } catch (error) {
        console.error("Error moving bookmark:", error.message, error.chromeErrorDetails);
        if (error.chromeErrorDetails?.message.toLowerCase().includes("can't move node into its own child")) {
            showFeedback("Cannot move folder into its own subfolder.", true);
        } else if (error.chromeErrorDetails?.message.toLowerCase().includes("can't modify the root node")){
            showFeedback("Cannot move to root. Select a folder.", true);
        } else {
            showFeedback(`Error moving: ${error.message}`, true);
        }
    }
}

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

function filterFolderOptions(isInitialCall = false) {
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

async function handleBookmarkChange(id, eventData) {
    console.log(`%cBookmark event detected (ID: ${id}, Data: ${JSON.stringify(eventData)}). Resetting 'hasPopulatedBookmarkFolders' flag.`, 'color: steelblue;');
    if (hasPopulatedBookmarkFolders) {
        hasPopulatedBookmarkFolders = false;
        console.log("  Flag 'hasPopulatedBookmarkFolders' reset. Second dropdown will repopulate on next interaction.");
    }
    // If the user *manually* changes folder structure outside the extension,
    // they'll need to use the "Refresh Folder List" button or wait for cache expiry.
    // This handler no longer dirties the main folder cache.
}

async function manualRefreshFolders() {
    showFeedback("Refreshing folder list...", false, 0);
    console.log("%cManual Refresh TRIGGERED", "background: yellow; color: black;");
    let refreshStart = performance.now();
    try {
        const allFoldersFlat = await getFullFolderHierarchy(true); // Force refresh
        await updateFolderSelect(allFoldersFlat);
        await populateBookmarkFolderOptions(true); // Force repopulate this too
        
        showFeedback("Folder list refreshed!", false, 3000);
    } catch (error) {
        console.error("Error during manual folder refresh:", error);
        showFeedback("Error refreshing folder list.", true, 5000);
    }
    console.log(`Manual refresh process took ${performance.now() - refreshStart} ms.`);
}

document.addEventListener('DOMContentLoaded', async () => {
    let perfStartDOM = performance.now();
    console.log("DOM fully loaded and parsed");

    const folderSelect = document.getElementById('folderSelect');
    const searchInput = document.getElementById('searchInput');
    const bookmarkFolderSelectElement = document.getElementById('bookmarkFolderSelect');
    const refreshFoldersButton = document.getElementById('refreshFoldersButton');

    folderSelect.innerHTML = '<option value="" disabled selected>Loading folders...</option>';
    bookmarkFolderSelectElement.innerHTML = '<option value="" disabled selected>Current page locations</option>';

    const addClickListener = (id, handler, lazyLoadSecondDropdown = false) => {
        const element = document.getElementById(id);
        if (element) {
            if (lazyLoadSecondDropdown) {
                element.addEventListener('click', async (event) => {
                    if (!hasPopulatedBookmarkFolders) {
                        console.log(`Lazy loading for ${id} click: Populating 'Bookmark's Saved Folders'.`);
                        await populateBookmarkFolderOptions(true);
                    }
                    if (handler.constructor.name === 'AsyncFunction') {
                        await handler(event);
                    } else {
                        handler(event);
                    }
                });
            } else {
                element.addEventListener('click', handler);
            }
        } else {
            console.error(`Element '${id}' not found.`);
        }
    };

    addClickListener('setDefaultButton', setDefaultFolder);
    addClickListener('searchFolder', searchBookmarkFolder);
    addClickListener('saveButton', saveBookmark);
    addClickListener('moveButton', moveBookmark, true); 
    addClickListener('deleteButton', deleteBookmark, true);
    
    if (refreshFoldersButton) {
        refreshFoldersButton.addEventListener('click', manualRefreshFolders);
    } else {
        console.warn("Element with ID 'refreshFoldersButton' not found. Manual refresh disabled.");
    }

    if (bookmarkFolderSelectElement) {
        bookmarkFolderSelectElement.addEventListener('focus', async () => {
            if (!hasPopulatedBookmarkFolders) {
                console.log("Lazy loading for bookmarkFolderSelect focus: Populating 'Bookmark's Saved Folders'.");
                await populateBookmarkFolderOptions(true);
            }
        }, { once: true });
    }

    if (searchInput) searchInput.addEventListener('input', debounce(() => filterFolderOptions(false), 250));
    else console.warn("'searchInput' not found.");
    
    console.log("Core event listeners attached.");

    if (chrome.bookmarks.onCreated.hasListener(handleBookmarkChange)) {
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
    

    try {
        const allFoldersFlat = await getFullFolderHierarchy(); 
        await updateFolderSelect(allFoldersFlat);
        
        console.log("Primary folder list populated. Second dropdown (Bookmark's Saved Folders) will load lazily on interaction.");

    } catch (error) {
        console.error("Error during initial setup:", error.message);
        folderSelect.innerHTML = '<option value="" disabled selected>Error loading folders</option>';
        showFeedback("Critical error during init. Check console.", true, 0);
    }
    console.log(`Initial setup (DOMContentLoaded) complete. Total time: ${performance.now() - perfStartDOM} ms.`);
});