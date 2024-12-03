function winCheck (game) : boolean {
    for (let i = 0; i < game.length; i+=3){
        if (game[i] != "" && game[i] == game[i+1] && game[i] == game[i+2]){
            return true;
        }
    }
    for (let i = 0; i < 3; i++){
        if (game[i] != "" && game[i] == game[i+3] && game[i] == game[i+6]){
            return true;
        }
    }
    if (game[0] != "" && game[0] == game[4] && game[0] == game[8]){ 
        return true;
    }
    if (game[2] != "" && game[2] == game[4] && game[2] == game[6]){
        return true;
    }
    return false;
}

// enum to track players
enum Player {
    X = 'X',
    O = 'O',
}

// initialize currentplayer to X
let currentPlayer: Player = Player.X;

// link to where images are stored
const playerImages: { [key in Player]: string } = {
    [Player.X]: './images/horse.jpg',
    [Player.O]: './images/rabbit.jpg',
};

// Select all buttons with the class 'item-button'
const buttons = document.querySelectorAll<HTMLButtonElement>('.item-button');

// declaring array to store button values
let gameState: String[] = [];
for (let i = 0; i < 10; i++) {
    gameState[i] = "";
    
}
var indexValue: number = 0, turnCount: number = 0;
var win: boolean = false;

// Add click event listener to each button
buttons.forEach((button) => {
    button.addEventListener('click', () => handleClick(button));
});

/**
 * Handle the click event on a button.
 * @param button The button that was clicked.
 */
function handleClick(button: HTMLButtonElement) {
    // Prevent overriding an already clicked button
    if (button.dataset.player || win) {
        return;
    }

    // Insert the image corresponding to the current player
    const img = document.createElement('img');
    img.src = playerImages[currentPlayer];
    img.alt = currentPlayer;
    img.draggable = false; // Prevent dragging the image

    button.appendChild(img);

    // Mark the button as clicked by the current player
    button.dataset.player = currentPlayer;
    

    // Check for a win or draw here (optional)
    indexValue = (button.dataset.index as unknown) as number;
    gameState[indexValue-1] = button.dataset.player;
    turnCount++;
    if (turnCount > 4){
        if (winCheck(gameState)){
            if (currentPlayer == "X"){
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
    if (!win){
        if (currentPlayer == "O"){
            document.getElementById("wintext").innerText = "rabbit's turn! turncount: " + turnCount;
        }
        else{
            document.getElementById("wintext").innerText = "horse's turn! turncount: " + turnCount;
        }
    }
    if (turnCount == 9 && !win){
        document.getElementById("wintext").innerText = "draw!";
        document.getElementById("refreshtext").innerText = "refresh to play again!";
    }
    
    
}

// Optional: Implement game reset, win checking, etc.