// Function to populate the select dropdown with folder options
async function populateFolderOptions() {
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

//populate the dropdown which contains all of the folders where the bookmark has been saved to
async function populateBookmarkFolderOptions() {
    const select = document.getElementById('bookmarkFolderSelect');
    select.innerHTML = '';
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        const currentTab = tabs[0]; // there will be only one in this array
        chrome.bookmarks.search({url: currentTab.url}, function(bookmarks) {
            bookmarks.forEach(function(bookmark) {
                chrome.bookmarks.getSubTree(bookmark.parentId, function(results) {
                    results.forEach(function(result) {
                        const option = document.createElement('option');
                        option.text = result.title;
                        option.value = result.id;
                        select.add(option);
                    });
                });
            });
        
            chrome.storage.sync.get(['lastBookmarkedFolderID'], function(result) {
                const lastFolderID = result.lastBookmarkedFolderID;
        
                if (lastFolderID) {
                    // Find the option element with the default folder ID
                    const defaultOption = select.querySelector(`option[value="${lastFolderID}"]`);
                    if (defaultOption) {
                        // Set the selected attribute for the default option
                        defaultOption.selected = true;
                    }
                }
            });
        });
    });
}

//in a folder, search for some keyword, and return those bookmarks that match it
async function searchBookmarkFolder(){
    const select = document.getElementById('folderBookmarks');
    const folderId = document.getElementById('folderSelect').value;
    select.innerHTML = '';
    
    //to avoid the first bookmark from being unopenable
    const defaultOption = document.createElement('option');
    defaultOption.text = 'Please select...';
    defaultOption.value = '';
    select.add(defaultOption);
    //open all bookmarks that match the given keyword
    const openAllBkms = document.createElement('option');
    openAllBkms.text = 'Open All';
    openAllBkms.value = '';
    select.add(openAllBkms);

    //delete all bookmarks that match the given keyword
    const deleteAllBkms = document.createElement('option');
    deleteAllBkms.text = 'Delete All';
    deleteAllBkms.value = '';
    select.add(deleteAllBkms);

    const searchString = searchInput.value.toLowerCase();
    chrome.bookmarks.getChildren(folderId, function(bookmarks) {
        bookmarks.forEach(function(bookmark) {

            if (bookmark.title.toLowerCase().includes(searchString)){
                const option = document.createElement('option');
                option.text = bookmark.title;
                option.value = bookmark.id;
                option.href = bookmark.url;
                select.add(option);
                option.style.display = option.text.toLowerCase();
            }
        });
    });
    bkmOptionMonitor(select);
}

//after finding and populating the dropdown menu with all found bookmarks, setup the monitor for any changes
function bkmOptionMonitor(select){
    //open bookmark(s) upon selecting a choice from dropdown menu
    select.onchange = function() {
        const selectedOption = select.options[select.selectedIndex]
        const confirmationMessage = selectedOption.text === "Open All" ?
        "Open all matching bookmarks from this folder?" :
        "Delete all matching bookmarks from this folder?";
    
        if (selectedOption.text === "Open All" || selectedOption.text === "Delete All") {
            if (confirm(confirmationMessage)) {
              select.selectedIndex += 1;
              while (select.options[select.selectedIndex]) {
                const bkm = select.options[select.selectedIndex];
                if (bkm.href) {
                  if (selectedOption.text === "Open All") {
                    chrome.tabs.create({ url: bkm.href, active: false });
                  } else {
                    chrome.bookmarks.remove(bkm.value);
                  }
                }
                select.selectedIndex += 1;
              }
              if (selectedOption.text == "Delete All")//auto refresh dropdown menu, no need to do it for opening actions
                  searchBookmarkFolder();
            }
          } else {
            // Open a single bookmark
            const bkmURL = selectedOption.href;
            if (bkmURL) {
              chrome.tabs.create({ url: bkmURL, active: false });
            }
          }
        };
}


// Function to save the bookmark to a selected folder
function saveBookmark() {
    const folderId = document.getElementById('folderSelect').value;
    if (folderId){
        chrome.tabs.query({ 'currentWindow': true, 'highlighted': true }, function(tabs) {
            // Check if there are any highlighted tabs
            if (tabs && tabs.length > 0) {
                // Iterate through the highlighted tabs
                tabs.forEach(function(tab) {
                    // Create a new bookmark object
                    const bookmark = {
                        parentId: folderId,
                        title: tab.title,
                        url: tab.url
                    };
                    // Save the bookmark using Chrome's bookmarks API
                    chrome.bookmarks.create(bookmark, function(result) {
                        // log result
                        //chrome.runtime.sendMessage({ message: ['Bookmark saved:', result] });
                    });
                });
            }
            chrome.storage.sync.set({'lastBookmarkedFolderID': folderId}, function() {
                chrome.runtime.sendMessage({ message: 'Folder ID saved'});
                });
            populateBookmarkFolderOptions();//refresh saved folders list of bookmark
        });
    }
    const feedbackDiv = document.getElementById('saved');
    feedbackDiv.textContent = 'Bookmark saved!';
}

//set a default folder which to save bookmarks to
function setDefaultFolder(){
    const folderId = document.getElementById('folderSelect').value;
    chrome.storage.sync.set({'defaultFolderId': folderId}, function() {
        chrome.runtime.sendMessage({ message: 'Folder ID saved'});
        });
            // Simulate a successful action by updating the UI
    const feedbackDiv = document.getElementById('saved');
    feedbackDiv.textContent = 'Default folder set!';
}

// delete the bookmark from a selected folder
function deleteBookmark(foldElemID='bookmarkFolderSelect') {
    const folderId = document.getElementById(foldElemID).value;
    if (folderId){
        chrome.tabs.query({ 'currentWindow': true, 'highlighted': true }, function(tabs) {
        // Check if there are any highlighted tabs
            if (tabs && tabs.length > 0) {
                // Iterate through the highlighted tabs
                tabs.forEach(function(tab) {
                    // Create a new bookmark object
                    const bookmark = {
                        parentId: folderId,
                        title: tab.title,
                        url: tab.url
                    };  
                    // Delete the bookmark using Chrome's bookmarks API
                    chrome.bookmarks.search({ url: bookmark.url }, function(results) {
                        if (results.length > 0) {//bookmark exists or not
                            const chosenBookmarked = results.find((bookmarkID) => bookmarkID.parentId === bookmark.parentId);
                            results.pop(chosenBookmarked);
                            //chrome.runtime.sendMessage({ message: ["Num bookmarks", results.length]});       
                            chrome.bookmarks.remove(chosenBookmarked.id, function() {
                            //chrome.runtime.sendMessage({ message: ['Bookmark removed:', results, chosenBookmarked, bookmark.parentId] });

                            if (results.length > 0){//if no bookmark in any folder, then can't set other folder as default
                                chrome.storage.sync.set({'lastBookmarkedFolderID': results.pop().id}, function() {
                                    chrome.runtime.sendMessage({ message: 'Default folder ID saved'});
                                    });
                                }
                            }); 
                        }
                    });
                });
            }
            populateBookmarkFolderOptions();//refresh saved folders list of bookmark
        });
    }
    const feedbackDiv = document.getElementById('saved');
    feedbackDiv.textContent = 'Bookmark deleted!';
}

//move bookmark from one folder to another
function moveBookmark(){
    const feedbackDiv = document.getElementById('saved');
    const numBookmarks = document.getElementById('bookmarkFolderSelect').length;
    if (numBookmarks > 0){
        const bookmarkFolderId = 'bookmarkFolderSelect';    
        deleteBookmark(bookmarkFolderId);
        setTimeout(() => {saveBookmark()}, 100);//delay execution a bit to avoid duplicate values folders being shown
        feedbackDiv.textContent = 'Bookmark moved!';
        chrome.runtime.sendMessage({ message: 'Bookmark successfully moved!'});
    }
    else{
        feedbackDiv.textContent = 'No bookmark to move!';
        chrome.runtime.sendMessage({ message: 'No bookmark to move'});
    }
}


// Populate folder options when the popup is opened
document.addEventListener('DOMContentLoaded', function() {
    populateFolderOptions();
    populateBookmarkFolderOptions();
    document.getElementById('setDefaultButton').addEventListener('click', setDefaultFolder);
    document.getElementById('searchFolder').addEventListener('click', searchBookmarkFolder);
    document.getElementById('saveButton').addEventListener('click', saveBookmark);
    document.getElementById('moveButton').addEventListener('click',moveBookmark);
    document.getElementById('deleteButton').addEventListener('click', function() {deleteBookmark()});
});
