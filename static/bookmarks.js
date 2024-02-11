// Function to populate the select dropdown with folder options
function populateFolderOptions() {
    chrome.bookmarks.getTree(bookmarkTreeNodes => {
        const select = document.getElementById('folderSelect');
        const searchInput = document.getElementById('searchInput');

        // Recursive function to process each node
        const processNode = node => {
            if (node.children) {
                const option = document.createElement('option');
                option.text = node.title;
                option.value = node.id;
                select.add(option);
                // Process children
                for (const child of node.children) {
                    processNode(child);
                }
            }
        };
        // Start processing from the root
        for (const rootNode of bookmarkTreeNodes) {
            processNode(rootNode);
        }
        // Add event listener for search input
        searchInput.addEventListener('input', event => {
            const searchString = event.target.value.toLowerCase();
            for (const option of Array.from(select.options)) {
                option.style.display = option.text.toLowerCase().includes(searchString) ? 'block' : 'none';
            }
        });
        chrome.storage.sync.get(['defaultFolderId'], function(result) {
            const defaultFolderId = result.defaultFolderId;

            if (defaultFolderId) {
                // Find the option element with the default folder ID
                const defaultOption = select.querySelector(`option[value="${defaultFolderId}"]`);
                if (defaultOption) {
                    // Set the selected attribute for the default option
                    defaultOption.selected = true;
                }
            }
        });
    });
}


function populateBookmarkFolderOptions() {
    const select = document.getElementById('bookmarkFolderSelect');
    select.innerHTML = '';
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        var currentTab = tabs[0]; // there will be only one in this array
        chrome.bookmarks.search({url: currentTab.url}, function(bookmarks) {
            bookmarks.forEach(function(bookmark) {
                chrome.bookmarks.getSubTree(bookmark.parentId, function(results) {
                    const select = document.getElementById('bookmarkFolderSelect');
                    results.forEach(function(result) {
                        const option = document.createElement('option');
                        option.text = result.title;
                        option.value = result.id;
                        select.add(option);
                    });
                });
            });
        });
    });
}


// Function to save the bookmark to the selected folder
function saveBookmark() {
    var folderId = document.getElementById('folderSelect').value;

    chrome.tabs.query({ 'currentWindow': true, 'highlighted': true }, function(tabs) {
        // Check if there are any highlighted tabs
        if (tabs && tabs.length > 0) {
            // Iterate through the highlighted tabs
            tabs.forEach(function(tab) {
                // Create a new bookmark object
                var bookmark = {
                    parentId: folderId,
                    title: tab.title,
                    url: tab.url
                };

                // Save the bookmark using Chrome's bookmarks API
                chrome.bookmarks.create(bookmark, function(result) {
                    // log result
                    chrome.runtime.sendMessage({ message: ['Bookmark saved:', result] });
                });
            });
        }
    });
    var feedbackDiv = document.getElementById('saved');
    feedbackDiv.textContent = 'Bookmark saved!';
    populateBookmarkFolderOptions();//refresh saved folders list of bookmark
}

function setDefaultFolder(){
    var folderId = document.getElementById('folderSelect').value;
    chrome.storage.sync.set({'defaultFolderId': folderId}, function() {
        chrome.runtime.sendMessage({ message: 'Folder ID saved'});
        });
            // Simulate a successful action by updating the UI
    var feedbackDiv = document.getElementById('saved');
    feedbackDiv.textContent = 'Default folder set!';
}

// Function to save the bookmark to the selected folder
function deleteBookmark() {
    var folderId = document.getElementById('folderSelect').value;

    chrome.tabs.query({ 'currentWindow': true, 'highlighted': true }, function(tabs) {
        // Check if there are any highlighted tabs
        if (tabs && tabs.length > 0) {
            // Iterate through the highlighted tabs
            tabs.forEach(function(tab) {
                // Create a new bookmark object
                var bookmark = {
                    parentId: folderId,
                    title: tab.title,
                    url: tab.url
                };
                // Delete the bookmark using Chrome's bookmarks API
                chrome.bookmarks.search({ title: bookmark.title, url: bookmark.url }, function(results) {
                    if (results.length > 0) {
                        chrome.runtime.sendMessage({ message: results.length});
                        
                        chrome.bookmarks.remove(results[0].id, function() {
                        chrome.runtime.sendMessage({ message: ['Bookmark removed:', bookmark] });
                        populateBookmarkFolderOptions();//refresh saved folders list of bookmark
                        });
                    }
                });
            });
        }
    });
    var feedbackDiv = document.getElementById('saved');
    feedbackDiv.textContent = 'Bookmark deleted!';

}



// Populate folder options when the popup is opened
document.addEventListener('DOMContentLoaded', function() {
    populateFolderOptions();
    populateBookmarkFolderOptions();
    
    document.getElementById('saveButton').addEventListener('click', saveBookmark);
    document.getElementById('deleteButton').addEventListener('click', deleteBookmark);
    document.getElementById('setDefaultButton').addEventListener('click', setDefaultFolder);
});

chrome.commands.onCommand.addListener(function(command) {
    if (command === "save-bookmark") {

        populateFolderOptions();
        saveBookmark();
    }
});
