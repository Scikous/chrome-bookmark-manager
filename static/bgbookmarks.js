// Function to save the bookmark to the default folder without opening popup
function saveBookmarkBG() {
    chrome.storage.sync.get(['defaultFolderId'], function(result) {
        const defaultFolderId = result.defaultFolderId;

        if (defaultFolderId) {
            chrome.tabs.query({ 'currentWindow': true, 'highlighted': true }, function(tabs) {
                // Check if there are any highlighted tabs
                if (tabs && tabs.length > 0) {
                    // Iterate through the highlighted tabs
                    tabs.forEach(function(tab) {
                        // Create a new bookmark object
                        var bookmark = {
                            parentId: defaultFolderId,
                            title: tab.title,
                            url: tab.url
                        };
        
                        // Save the bookmark using Chrome's bookmarks API
                        chrome.bookmarks.create(bookmark, function(result) {
                            // log result
                           console.log('Bookmark saved:', result);
                        });
                    });
                }
            });
        }
    });
}

// Function to save the bookmark to the selected folder
function deleteBookmarkBG() {

    chrome.storage.sync.get(['defaultFolderId'], function(result) {
        const defaultFolderId = result.defaultFolderId;

        if (defaultFolderId) {
            chrome.tabs.query({ 'currentWindow': true, 'highlighted': true }, function(tabs) {
                // Check if there are any highlighted tabs
                if (tabs && tabs.length > 0) {
                    // Iterate through the highlighted tabs
                    tabs.forEach(function(tab) {
                        // Create a new bookmark object
                        var bookmark = {
                            parentId: defaultFolderId,
                            title: tab.title,
                            url: tab.url
                        };

                        // Delete the bookmark
                        chrome.bookmarks.search({url: bookmark.url }, function(results) {
                            if (results.length > 0) {
                                lastBookmarked = results.pop();
                                console.log("Num bookmarks", results.length);
                                
                                chrome.bookmarks.remove(lastBookmarked.id, function() {
                                console.log('Bookmark removed:', bookmark);
                                });
                            }
                        });
                    });
                }
            });
        }
    });
}

chrome.commands.onCommand.addListener(function(command) {
    if (command === "save-bookmark") {
        saveBookmarkBG();
    }
    else if (command === "delete-bookmark"){
        deleteBookmarkBG();
    }
});

// Listen for messages from content scripts or other parts of the extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(message); // Log the message received
});
