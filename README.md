# Chrome Bookmark Manager

## Important Notes
> [!NOTE]
> This extension uses URL-based bookmark searching rather than tab titles. This may affect search accuracy depending on your bookmark naming conventions.

## Features

### Bookmark Management
- Save to multiple folders from single/multiple tabs
- Delete from multiple folders
- Set persistent default save folder

### Search & Navigation
- Keyword search within folders
- Open matches in new tabs
- Bulk delete matching bookmarks

### Keyboard Shortcuts
- Ctrl+Shift+S: Save to default folder
- Ctrl+Shift+Z: Cycle through deletion locations

## Installation
1. Clone or download repository
2. Navigate to `chrome://extensions`
3. Enable **Developer Mode** (toggle top-right)
4. Click **Load Unpacked** and select: `Path\To\Your\Repo\chrome-bookmark-manager`
5. (Recommended) Configure shortcuts:
   - Right-click extension > **Options** > **Keyboard shortcuts**

## Usage Guide

### Popup
#### Saving/Moving/Deleting Bookmarks
1. Open extension popup
2. Select folder
3. Move/Delete works based on selected folder of the second dropdown -- Move will move from second drop-down to first dropdown selection, Delete will delete from second dropdown selection

#### Default Folder
1. Select desired folder
2. Click **Set default folder**

#### Searching
1. Enter search query -- Either Folder or Bookmark
2. **Search Folder** -- Find bookmarks within folder
3. From dropdown click **Delete All** to delete all bookmarks from folder
4. From dropdown click **Open All** to open all bookmarks in new tabs


#### Refresh Folder List
1. Click **Refresh Folder List** to update folder list -- If folders themselves have been modified in any way

### Shortcut Setup
> ℹ️ Default folder must be selected before using shortcuts

1. Open extension options
2. Navigate to **Keyboard Shortcuts**
3. Assign:
   - **Save Bookmark**: Ctrl+Shift+S
   - **Delete Bookmark**: Ctrl+Shift+Z

