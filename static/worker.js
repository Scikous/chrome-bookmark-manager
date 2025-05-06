// static/worker.js

// Helper function to recursively collect folders from the tree
function collectFolders(nodes, folders) {
    for (const node of nodes) {
        // Check if it's a folder (no URL property) and has a title, exclude root '0'
        if (!node.url && node.title && node.id !== '0') {
            folders.push({ id: node.id, title: node.title });
        }
        // If the node has children, recurse
        if (node.children) {
            collectFolders(node.children, folders);
        }
    }
}

// Fetches and processes folder data using getTree
async function getFolderData() {
    let folders = [];
    try {
        // Promisify chrome.bookmarks.getTree
        const getBookmarkTree = () => new Promise((resolve, reject) => {
            chrome.bookmarks.getTree((results) => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(results);
            });
        });

        console.log("Worker: Fetching bookmark tree...");
        const bookmarkTree = await getBookmarkTree();

        if (!bookmarkTree || bookmarkTree.length === 0) {
            console.log("Worker: Bookmark tree is empty or could not be fetched.");
            return []; // Return empty array
        }
        console.log("Worker: Bookmark tree fetched.");

        collectFolders(bookmarkTree, folders);
        console.log(`Worker: Collected ${folders.length} folders from tree.`);

        // Sort folders alphabetically by title
        folders.sort((a, b) => a.title.localeCompare(b.title));
        return folders;

    } catch (error) {
        console.error("Worker: Error getting folder data using getTree:", error);
        // Post error back to main thread
        self.postMessage({ error: error.message || 'Unknown error fetching folders' });
        return []; // Return empty on error after posting
    }
}

// Listen for messages from the main thread
self.onmessage = async (event) => {
    if (event.data === 'getFolders') {
        console.log("Worker: Received request to get folders.");
        const folders = await getFolderData();
        // Post the processed folder list back to the main thread
        console.log(`Worker: Posting ${folders.length} folders back to main thread.`);
        self.postMessage({ folders: folders });
    }
};

console.log("Worker initialized.");