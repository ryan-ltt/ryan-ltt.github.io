/*
function updateText(){

}
*/
var _a;
/*
hw: no new features, refactor code & find opportunities to reduce duplication, simplify logic, fix squiggly errors
investigate html/css further, make UI more interesting/elegant/user friendly. implement refresh button
implement instructions underneath a detail summary, like an accordion to show instructions
easier navigation of the website, back to home page
try it on mobile, look up how to manipulate meta-properties to make it installable (manifest property)

weeks ahead: further progress, multiplayer with other real humans
this would require server to save state, facilitate connections
try to do js server

reading list: the phoenix project
*/
// enum to track players
var Player;
(function (Player) {
    Player["X"] = "X";
    Player["O"] = "O";
})(Player || (Player = {}));
// initialize currentplayer to X to start game
var currentPlayer = Player.X;
// link to where images are stored
var playerImages = (_a = {},
    _a[Player.X] = "images/horse.jpg",
    _a[Player.O] = "images/rabbit.jpg",
    _a);
var gameState = [];
for (var i = 0; i < 10; i++) {
    gameState[i] = "";
}
var turnCount = 0;
var hasWon = false;
// Select all buttons with the class 'item-button' and add click event listener to each button
var buttons = document.querySelectorAll(".item-button");
buttons.forEach(function (button) {
    button.addEventListener("click", function () { return handleClick(button); });
});
var gameText = document.getElementById("gametext");
var refreshText = document.getElementById("refreshtext");
/**
 * Handle the click event on a button.
 * @param button The button that was clicked.
 */
function handleClick(button) {
    // Prevent overriding an already clicked button
    if (button.dataset.player || hasWon) {
        return;
    }
    button.dataset.player = currentPlayer;
    var indexValue = Number(button.dataset.index) - 1;
    var player = button.dataset.player;
    // Update game state
    gameState[indexValue] = player;
    console.log(button.dataset.player);
    turnCount++;
    // Then update UI
    updateButtonWithPlayer(button);
    // Check win conditions
    console.log(gameState);
    hasWon = checkWin(gameState);
    if (hasWon) {
        gameText.innerText =
            currentPlayer === Player.X ? "the horse wins!" : "the rabbit wins!";
        refreshText.innerText = "refresh to play again!";
        return;
    }
    // check for draw
    if (turnCount === 9 && !hasWon) {
        gameText.innerText = "draw!";
        refreshText.innerText = "refresh to play again!";
        return;
    }
    // otherwise keep playing
    currentPlayer = currentPlayer === Player.X ? Player.O : Player.X;
    gameText.innerText =
        currentPlayer === Player.X ? "horse's turn!" : "rabbit's turn!";
    refreshText.innerText = "";
}
function updateButtonWithPlayer(button) {
    // Insert the image corresponding to the current player
    var img = document.createElement("img");
    img.src = playerImages[currentPlayer];
    img.alt = currentPlayer;
    img.draggable = false; // Prevent dragging the image
    button.appendChild(img);
}
/**
 *
 * @param game
 * @returns
 */
function checkWin(game) {
    // checking rows for 3 in a row
    for (var i = 0; i < game.length; i += 3) {
        if (game[i] !== "" && game[i] === game[i + 1] && game[i] === game[i + 2]) {
            return true;
        }
    }
    // checking columns for 3 in a row
    for (var i = 0; i < 3; i++) {
        if (game[i] !== "" && game[i] === game[i + 3] && game[i] === game[i + 6]) {
            return true;
        }
    }
    // checking diagonals manually, \ diag
    if (game[0] !== "" && game[0] === game[4] && game[0] === game[8]) {
        return true;
    }
    // checking / diag
    if (game[2] !== "" && game[2] === game[4] && game[2] === game[6]) {
        return true;
    }
    return false;
}
