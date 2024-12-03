var _a;
function winCheck(game) {
    for (var i = 0; i < game.length; i += 3) {
        if (game[i] != "" && game[i] == game[i + 1] && game[i] == game[i + 2]) {
            return true;
        }
    }
    for (var i = 0; i < 3; i++) {
        if (game[i] != "" && game[i] == game[i + 3] && game[i] == game[i + 6]) {
            return true;
        }
    }
    if (game[0] != "" && game[0] == game[4] && game[0] == game[8]) {
        return true;
    }
    if (game[2] != "" && game[2] == game[4] && game[2] == game[6]) {
        return true;
    }
    return false;
}
// enum to track players
var Player;
(function (Player) {
    Player["X"] = "X";
    Player["O"] = "O";
})(Player || (Player = {}));
// initialize currentplayer to X
var currentPlayer = Player.X;
// link to where images are stored
var playerImages = (_a = {},
    _a[Player.X] = './images/horse.jpg',
    _a[Player.O] = './images/rabbit.jpg',
    _a);
// Select all buttons with the class 'item-button'
var buttons = document.querySelectorAll('.item-button');
// declaring array to store button values
var gameState = [];
for (var i = 0; i < 10; i++) {
    gameState[i] = "";
}
var indexValue = 0, turnCount = 0;
var win = false;
// Add click event listener to each button
buttons.forEach(function (button) {
    button.addEventListener('click', function () { return handleClick(button); });
});
/**
 * Handle the click event on a button.
 * @param button The button that was clicked.
 */
function handleClick(button) {
    // Prevent overriding an already clicked button
    if (button.dataset.player || win) {
        return;
    }
    // Insert the image corresponding to the current player
    var img = document.createElement('img');
    img.src = playerImages[currentPlayer];
    img.alt = currentPlayer;
    img.draggable = false; // Prevent dragging the image
    button.appendChild(img);
    // Mark the button as clicked by the current player
    button.dataset.player = currentPlayer;
    // Check for a win or draw here (optional)
    indexValue = button.dataset.index;
    gameState[indexValue - 1] = button.dataset.player;
    turnCount++;
    if (turnCount > 4) {
        if (winCheck(gameState)) {
            if (currentPlayer == "X") {
                document.getElementById("wintext").innerText = "the horse wins!";
            }
            else {
                document.getElementById("wintext").innerText = "the rabbit wins!";
            }
            win = true;
            document.getElementById("refreshtext").innerText = "refresh to play again!";
        }
    }
    // Switch to the other player
    currentPlayer = currentPlayer === Player.X ? Player.O : Player.X;
    if (!win) {
        if (currentPlayer == "O") {
            document.getElementById("wintext").innerText = "rabbit's turn! turncount: " + turnCount;
        }
        else {
            document.getElementById("wintext").innerText = "horse's turn! turncount: " + turnCount;
        }
    }
    if (turnCount == 9 && !win) {
        document.getElementById("wintext").innerText = "draw!";
        document.getElementById("refreshtext").innerText = "refresh to play again!";
    }
}
// Optional: Implement game reset, win checking, etc.
